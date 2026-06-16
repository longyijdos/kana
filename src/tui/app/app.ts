import type { Agent, BeforeToolExecutionHook, BeforeToolExecutionResult } from "@/agent";
import type { Message, ModelMetadata, ToolCallContent } from "@/core";
import type {
  KanaSessionMetadata,
  KanaToolApprovalConfig,
  KanaToolApprovals,
  LoadKanaSkillActivationsResult,
} from "@/kana";
import {
  Editor,
  StatusLine,
  type StatusLineState,
  TextBlock,
  Transcript,
  WelcomeBlock,
} from "../components";
import { PROMPT_COMMANDS, type PromptCommandName } from "../components/editor/commands";
import type { ProcessTerminal } from "../runtime";
import { isCtrlC, isEscape, Tui } from "../runtime";
import { tuiTheme } from "../theme";
import { preloadSyntaxHighlighter } from "../utils/syntax-highlighter";
import { AgentEventRenderer } from "./agent-event-renderer";
import { addHistoryMessagesToTranscript } from "./history";
import { LocalShellController } from "./local-shell-controller";
import { SessionOverlayController } from "./session-overlay-controller";
import { SkillManagerController } from "./skill-manager-controller";
import type { RunPhase } from "./status-phase";
import { ToolApprovalController } from "./tool-approval-controller";
import { WELCOME_LOGO_LINES } from "./welcome-logo";

export type KanaTuiLoadedSession = {
  id: string;
  messages: Message[];
};

export type KanaTuiAppOptions = {
  sessionId?: string;
  initialMessages?: Message[];
  initialPrompt?: string;
  getResumeSessionId: () => string | undefined;
  createNewSession: () => { id: string };
  forkSession: (messages: Message[], prompt: string) => { id: string };
  listSessions: () => KanaSessionMetadata[];
  loadSession: (sessionId: string) => KanaTuiLoadedSession;
  deleteSession: (sessionId: string) => boolean;
  loadSkills: () => LoadKanaSkillActivationsResult;
  saveEnabledGlobalSkills: (names: string[]) => void;
  startInResumePicker?: boolean;
  toolApproval: {
    config: KanaToolApprovalConfig;
    approvals: KanaToolApprovals;
  };
};

export class KanaTuiApp {
  private readonly tui: Tui;
  private readonly transcript = new Transcript();
  private readonly status: StatusLine;
  private readonly editor = new Editor();
  private readonly agentEvents: AgentEventRenderer;
  private readonly sessionOverlay: SessionOverlayController;
  private readonly skillManager: SkillManagerController;
  private agent: Agent;
  private sessionId?: string;
  private running = false;
  private readonly toolApproval: ToolApprovalController;
  private readonly localShell: LocalShellController;

  constructor(
    private readonly createAgent: (options: {
      beforeToolExecution: BeforeToolExecutionHook;
      messages?: Message[];
    }) => Agent,
    terminal: ProcessTerminal,
    private readonly options: KanaTuiAppOptions,
  ) {
    this.sessionId = options.sessionId;
    this.tui = new Tui(terminal);
    this.agentEvents = new AgentEventRenderer({
      transcript: this.transcript,
      tui: this.tui,
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.sessionOverlay = new SessionOverlayController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      listSessions: this.options.listSessions,
      deleteSession: this.options.deleteSession,
      hasCurrentSession: () => this.sessionId !== undefined,
      onResume: (sessionId) => this.resumeSession(sessionId),
      onStop: () => this.stop(),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.skillManager = new SkillManagerController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      loadSkills: this.options.loadSkills,
      saveEnabledGlobalSkills: this.options.saveEnabledGlobalSkills,
      onSkillsChanged: () => this.refreshAgentSystemPrompt(),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.toolApproval = new ToolApprovalController({
      ...options.toolApproval,
      transcript: this.transcript,
      editor: this.editor,
      tui: this.tui,
      onPromptShown: (toolName) => {
        this.updateStatus("tool", {
          activeTool: toolName,
        });
      },
    });
    this.localShell = new LocalShellController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      requestApproval: (toolCall, signal) => this.showToolApprovalPrompt(toolCall, signal),
      setRunning: (running) => {
        this.running = running;
      },
      clearRunStatus: () => {
        this.status.update({
          running: false,
          activeTool: undefined,
        });
      },
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.agent = this.createAgentForCurrentSession();
    this.status = new StatusLine(formatModelName(this.agent.state.model.metadata));
  }

  start(): void {
    void preloadSyntaxHighlighter().then(
      () => this.tui.requestRender(),
      () => undefined,
    );

    if (!this.options.startInResumePicker) {
      this.initializeTranscript(this.options.initialMessages ?? []);
    }

    this.tui.addChild(this.transcript);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.status);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.handleGlobalInput(data));
    this.editor.onSubmit = (submit) => {
      if (submit.type === "command") {
        this.handleCommand(submit);
        return;
      }

      if (submit.type === "shell") {
        void this.submitShellCommand(submit.command, submit.raw);
        return;
      }

      void this.submitPrompt(submit.content);
    };

    this.updateStatus("idle");
    this.tui.start();

    if (this.options.startInResumePicker) {
      this.openResumePicker();
      return;
    }

    if (this.options.initialPrompt) {
      void this.submitPrompt(this.options.initialPrompt);
    }
  }

  stop(): void {
    const resumeSessionId = this.options.getResumeSessionId();

    resumeSessionId
      ? this.tui.stop(`Resume this session with: kana resume ${resumeSessionId}`)
      : this.tui.stop();
  }

  private createAgentForCurrentSession(messages?: Message[]): Agent {
    return this.createAgent({
      beforeToolExecution: ({ toolCall, signal }) => this.showToolApprovalPrompt(toolCall, signal),
      messages,
    });
  }

  private initializeTranscript(initialMessages: Message[]): void {
    if (initialMessages.length > 0) {
      this.transcript.addChild(
        new TextBlock(`Resumed session ${this.sessionId ?? ""}.`, {
          color: tuiTheme.muted,
        }),
      );
      addHistoryMessagesToTranscript(this.transcript, initialMessages);
      return;
    }

    this.transcript.addChild(
      new WelcomeBlock({
        logoLines: WELCOME_LOGO_LINES,
        recentSessions: this.options.listSessions(),
      }),
    );
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (isCtrlC(data)) {
      if (this.running) {
        this.abort();
        return { consume: true };
      }

      this.stop();
      process.exit(0);
    }

    if (isEscape(data) && this.running) {
      this.abort();
      return { consume: true };
    }

    return undefined;
  }

  private abort(): void {
    if (this.localShell.abort()) {
      return;
    }

    this.agent.abort();
    this.updateStatus("aborted");
  }

  private handleCommand(command: {
    name: PromptCommandName;
    arguments: string;
    raw: string;
  }): void {
    switch (command.name) {
      case "quit":
        if (command.arguments) {
          void this.submitPrompt(command.raw);
          return;
        }

        this.stop();
        process.exit(0);
        break;
      case "help":
        if (command.arguments) {
          this.showError(new Error("Usage: /help"));
          return;
        }

        this.showHelp();
        break;
      case "clear":
        if (command.arguments) {
          void this.submitPrompt(command.raw);
          return;
        }

        this.transcript.clear();
        this.editor.clear();
        this.tui.requestRender(true);
        break;
      case "new":
        if (command.arguments) {
          void this.submitPrompt(command.raw);
          return;
        }

        this.startNewSession();
        break;
      case "fork":
        if (!command.arguments) {
          this.showError(new Error("Usage: /fork <prompt>"));
          return;
        }

        void this.forkSession(command.arguments);
        break;
      case "resume":
        if (command.arguments) {
          this.resumeSession(command.arguments);
          return;
        }

        this.openResumePicker();
        break;
      case "delete":
        if (command.arguments) {
          this.showError(new Error("Usage: /delete"));
          return;
        }

        this.openDeletePicker();
        break;
      case "skills":
        if (command.arguments) {
          this.showError(new Error("Usage: /skills"));
          return;
        }

        this.openSkillManager();
        break;
    }
  }

  private showHelp(): void {
    const lines = [
      "Slash commands",
      "",
      ...PROMPT_COMMANDS.map((command) => `/${command.name.padEnd(8)} ${command.description}`),
      "",
      "Shell shortcuts",
      "",
      "!<command> Run a local bash command.",
    ];

    this.editor.clear();
    this.transcript.addChild(
      new TextBlock(lines.join("\n"), {
        color: tuiTheme.muted,
        paddingTop: 1,
      }),
    );
    this.updateStatus("idle", {
      activeTool: undefined,
    });
    this.tui.requestRender();
  }

  private startNewSession(): void {
    if (this.running) {
      return;
    }

    this.sessionId = this.options.createNewSession().id;
    this.closeSessionOverlay();
    this.agent.reset();
    this.agentEvents.resetRun();
    this.transcript.clear();
    this.editor.clear();
    this.initializeTranscript([]);
    this.updateStatus("idle", {
      activeTool: undefined,
    });
    this.tui.requestRender(true);
  }

  private async forkSession(prompt: string): Promise<void> {
    if (this.running) {
      return;
    }

    this.sessionId = this.options.forkSession(this.agent.state.messages, prompt).id;
    this.closeSessionOverlay();
    this.editor.clear();
    this.transcript.addChild(
      new TextBlock(`Forked session ${this.sessionId}.`, {
        color: tuiTheme.muted,
        paddingTop: 1,
      }),
    );
    this.updateStatus("idle", {
      activeTool: undefined,
    });
    this.tui.requestRender();
    await this.submitPrompt(prompt);
  }

  private openResumePicker(): void {
    if (this.running) {
      return;
    }

    this.skillManager.close();
    this.sessionOverlay.openResume();
  }

  private openDeletePicker(): void {
    if (this.running) {
      return;
    }

    this.skillManager.close();
    this.sessionOverlay.openDelete();
  }

  private closeSessionOverlay(): void {
    this.sessionOverlay.close();
  }

  private refreshAgentSystemPrompt(): void {
    this.agent.abort();
    this.agent = this.createAgentForCurrentSession(this.agent.state.messages);
  }

  private openSkillManager(): void {
    if (this.running) {
      return;
    }

    this.closeSessionOverlay();
    this.skillManager.open();
  }

  private resumeSession(sessionId: string): void {
    if (this.running) {
      return;
    }

    let session: KanaTuiLoadedSession;

    try {
      session = this.options.loadSession(sessionId);
    } catch (error) {
      this.showError(error);
      this.closeSessionOverlay();
      this.tui.setFocus(this.editor);
      this.tui.requestRender(true);
      return;
    }

    this.closeSessionOverlay();
    this.sessionId = session.id;
    this.agent.abort();
    this.agent = this.createAgentForCurrentSession();
    this.agentEvents.resetRun();
    this.transcript.clear();
    this.editor.clear();
    this.initializeTranscript(session.messages);
    this.updateStatus("idle", {
      activeTool: undefined,
    });
    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);
  }

  private showError(error: unknown): void {
    this.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
        paddingTop: 1,
      }),
    );
    this.updateStatus("error");
  }

  private async submitPrompt(value: string): Promise<void> {
    const prompt = value.trim();

    if (!prompt || this.running) {
      return;
    }

    this.editor.addToHistory(prompt);
    this.editor.clear();
    this.transcript.addChild(new TextBlock(prompt, { color: tuiTheme.user, prefix: "> " }));
    this.running = true;
    this.agentEvents.resetRun();
    this.updateStatus("starting");

    try {
      const stream = this.agent.stream(prompt);

      for await (const event of stream) {
        this.agentEvents.handle(event);
      }

      await stream.result();
    } catch (error) {
      this.showError(error);
    } finally {
      this.running = false;
      this.status.update({
        running: false,
        activeTool: undefined,
      });
      this.tui.requestRender();
    }
  }

  private async submitShellCommand(command: string, raw: string): Promise<void> {
    const shellCommand = command.trim();

    if (!shellCommand || this.running) {
      return;
    }

    await this.localShell.submit(shellCommand, raw);
  }

  private showToolApprovalPrompt(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    return this.toolApproval.request(toolCall, signal);
  }

  private updateStatus(phase: RunPhase, extra: Partial<StatusLineState> = {}): void {
    this.status.update({
      phase,
      running: this.running,
      ...extra,
    });
  }
}

function formatModelName(metadata: ModelMetadata): string {
  return `${metadata.provider}/${metadata.model}`;
}
