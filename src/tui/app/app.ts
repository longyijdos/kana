import type {
  Agent,
  BeforeToolExecutionHook,
  BeforeToolExecutionResult,
} from "@/agent";
import type {
  KanaSessionMetadata,
  KanaToolApprovalConfig,
  KanaToolApprovals,
} from "@/kana";
import type { Message, ModelMetadata, ToolCallContent } from "@/core";
import { addHistoryMessagesToTranscript } from "./history";
import { AgentEventRenderer } from "./agent-event-renderer";
import { SessionOverlayController } from "./session-overlay-controller";
import type { RunPhase } from "./status-phase";
import { ToolApprovalController } from "./tool-approval-controller";
import { preloadSyntaxHighlighter } from "../utils/syntax-highlighter";
import {
  Editor,
  StatusLine,
  type StatusLineState,
  TextBlock,
  Transcript,
} from "../components";
import {
  isCtrlC,
  isEscape,
} from "../runtime";
import type { ProcessTerminal } from "../runtime";
import { tuiTheme } from "../theme";
import { Tui } from "../runtime";

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
  private agent: Agent;
  private sessionId?: string;
  private running = false;
  private readonly toolApproval: ToolApprovalController;

  constructor(
    private readonly createAgent: (options: {
      beforeToolExecution: BeforeToolExecutionHook;
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

    this.tui.stop(
      resumeSessionId
        ? `Resume this session with: kana resume ${resumeSessionId}`
        : "No saved session.",
    );
  }

  private createAgentForCurrentSession(): Agent {
    return this.createAgent({
      beforeToolExecution: ({ toolCall, signal }) =>
        this.showToolApprovalPrompt(toolCall, signal),
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
      new TextBlock("Kana TUI. Type a prompt and press Enter.", {
        color: tuiTheme.muted,
      }),
    );
    this.transcript.addChild(
      new TextBlock(
        "Use terminal scrollback for history, /clear to clear display, /new to start fresh, /fork <prompt> to branch, /resume to switch, /delete to remove saved sessions, or /quit to exit.",
        {
          color: tuiTheme.muted,
        },
      ),
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
    this.agent.abort();
    this.updateStatus("aborted");
  }

  private handleCommand(command: {
    name: "quit" | "clear" | "new" | "fork" | "resume" | "delete";
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
    }
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

    this.sessionOverlay.openResume();
  }

  private openDeletePicker(): void {
    if (this.running) {
      return;
    }

    this.sessionOverlay.openDelete();
  }

  private closeSessionOverlay(): void {
    this.sessionOverlay.close();
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
    this.transcript.addChild(
      new TextBlock(prompt, { color: tuiTheme.user, prefix: "> " }),
    );
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

  private showToolApprovalPrompt(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    return this.toolApproval.request(toolCall, signal);
  }

  private updateStatus(
    phase: RunPhase,
    extra: Partial<StatusLineState> = {},
  ): void {
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
