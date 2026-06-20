import type { Agent, BeforeToolExecutionHook, BeforeToolExecutionResult } from "@/agent";
import {
  addModelUsage,
  calculateContextUsedPercent,
  calculateUsageCostCny,
  findLatestAssistantUsage,
  type Message,
  type ModelMetadata,
  type ModelUsage,
  type ToolCallContent,
} from "@/core";
import type {
  KanaNotificationConfig,
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
import type { Terminal } from "../runtime";
import { isCtrlC, isCtrlO, isEscape, Tui } from "../runtime";
import { tuiTheme } from "../theme";
import { preloadSyntaxHighlighter } from "../utils/syntax-highlighter";
import { AgentEventRenderer } from "./agent-event-renderer";
import { AppLayout } from "./app-layout";
import { COMMAND_MESSAGES } from "./command-messages";
import { ContentViewerController } from "./content-viewer-controller";
import { addHistoryMessagesToTranscript } from "./history";
import { LocalShellController } from "./local-shell-controller";
import {
  MemoryCompactController,
  type MemoryCompactSummary,
  type MemoryCompactTarget,
} from "./memory-compact-controller";
import { NotificationController } from "./notification-controller";
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
  notification: KanaNotificationConfig;
  compactMemory: (
    target: MemoryCompactTarget,
    userRequest: string | undefined,
    signal: AbortSignal,
  ) => Promise<MemoryCompactSummary[]>;
  loadMemory: (target: "user" | "workspace") => string;
};

export class KanaTuiApp {
  private readonly tui: Tui;
  private readonly transcript = new Transcript();
  private readonly status: StatusLine;
  private readonly editor = new Editor();
  private readonly layout: AppLayout;
  private readonly agentEvents: AgentEventRenderer;
  private readonly sessionOverlay: SessionOverlayController;
  private readonly skillManager: SkillManagerController;
  private agent: Agent;
  private sessionId?: string;
  private running = false;
  private totalUsage?: ModelUsage;
  private totalCostCny = 0;
  private readonly toolApproval: ToolApprovalController;
  private readonly localShell: LocalShellController;
  private readonly contentViewer: ContentViewerController;
  private readonly notifications: NotificationController;
  private readonly memoryCompact: MemoryCompactController;

  constructor(
    private readonly createAgent: (options: {
      beforeToolExecution: BeforeToolExecutionHook;
      messages?: Message[];
    }) => Agent,
    terminal: Terminal,
    private readonly options: KanaTuiAppOptions,
  ) {
    this.sessionId = options.sessionId;
    this.tui = new Tui(terminal);
    this.notifications = new NotificationController(options.notification, terminal);
    this.agent = this.createAgentForCurrentSession();
    this.status = new StatusLine(formatModelName(this.agent.state.model.metadata));
    this.layout = new AppLayout({
      transcript: this.transcript,
      editor: this.editor,
      status: this.status,
    });
    this.agentEvents = new AgentEventRenderer({
      transcript: this.transcript,
      tui: this.tui,
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.sessionOverlay = new SessionOverlayController({
      editor: this.editor,
      layout: this.layout,
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
      layout: this.layout,
      transcript: this.transcript,
      tui: this.tui,
      loadSkills: this.options.loadSkills,
      saveEnabledGlobalSkills: this.options.saveEnabledGlobalSkills,
      onSkillsChanged: () => this.refreshAgentSystemPrompt(),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.contentViewer = new ContentViewerController({
      editor: this.editor,
      layout: this.layout,
      transcript: this.transcript,
      tui: this.tui,
      focusAfterClose: () => this.toolApproval.activePrompt,
    });
    this.toolApproval = new ToolApprovalController({
      ...options.toolApproval,
      editor: this.editor,
      layout: this.layout,
      tui: this.tui,
      shouldPreserveFocus: () => this.contentViewer.active,
      onPromptShown: (toolName) => {
        this.updateStatus("tool", {
          activeTool: toolName,
        });
        this.notifications.approvalRequired(toolName);
      },
    });
    this.localShell = new LocalShellController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
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
    this.memoryCompact = new MemoryCompactController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      compactMemory: this.options.compactMemory,
      setRunning: (running) => {
        this.running = running;
      },
      clearRunStatus: () => {
        this.status.update({ running: false, activeTool: undefined });
      },
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.updateContextUsageFromMessages(options.initialMessages ?? []);
  }

  start(): void {
    void preloadSyntaxHighlighter().then(
      () => this.tui.requestRender(),
      () => undefined,
    );

    if (!this.options.startInResumePicker) {
      this.initializeTranscript(this.options.initialMessages ?? []);
    }

    this.tui.addChild(this.layout);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.handleGlobalInput(data));
    this.editor.onSubmit = (submit) => {
      if (submit.type === "command") {
        this.handleCommand(submit);
        return;
      }

      if (submit.type === "shell") {
        void this.submitShellCommand(submit.command);
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
    const exitLines = [
      this.totalUsage
        ? formatExitLine("Token usage", formatModelUsage(this.totalUsage))
        : undefined,
      this.totalCostCny > 0 ? formatExitLine("API cost", formatCny(this.totalCostCny)) : undefined,
      resumeSessionId ? formatExitLine("Resume", `kana resume ${resumeSessionId}`) : undefined,
    ].filter((line): line is string => Boolean(line));

    exitLines.length > 0 ? this.tui.stop(exitLines.join("\r\n")) : this.tui.stop();
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
    if (isCtrlO(data)) {
      return this.contentViewer.toggleLatest() ? { consume: true } : undefined;
    }

    if (isEscape(data) && this.contentViewer.active) {
      this.contentViewer.close();
      return { consume: true };
    }

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

    if (this.memoryCompact.abort()) {
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
    if (this.running && command.name !== "quit") {
      return;
    }

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
          this.showError(new Error(COMMAND_MESSAGES.helpUsage));
          return;
        }

        this.showHelp();
        break;
      case "clear":
        if (command.arguments) {
          void this.submitPrompt(command.raw);
          return;
        }

        this.contentViewer.close();
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
          this.showError(new Error(COMMAND_MESSAGES.forkUsage));
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
          this.showError(new Error(COMMAND_MESSAGES.deleteUsage));
          return;
        }

        this.openDeletePicker();
        break;
      case "skills":
        if (command.arguments) {
          this.showError(new Error(COMMAND_MESSAGES.skillsUsage));
          return;
        }

        this.openSkillManager();
        break;
      case "memory":
        this.handleMemoryCommand(command.arguments);
        break;
    }
  }

  private handleMemoryCommand(argumentsText: string): void {
    const [subcommand, ...argumentsParts] = argumentsText.trim().split(/\s+/).filter(Boolean);

    if (subcommand === "compact") {
      void this.memoryCompact.compact(argumentsParts.join(" "));
      return;
    }

    if (subcommand === "show") {
      const requestedTarget = argumentsParts[0];
      const target =
        requestedTarget === "user" || requestedTarget === "workspace" ? requestedTarget : undefined;
      if (requestedTarget && !target) {
        this.showError(new Error(COMMAND_MESSAGES.memoryUsage));
        return;
      }

      this.openMemoryViewer(target);
      return;
    }

    this.showError(new Error(COMMAND_MESSAGES.memoryUsage));
  }

  private openMemoryViewer(target: "user" | "workspace" | undefined): void {
    const memoryTargets = target ? [target] : (["user", "workspace"] as const);
    const content = memoryTargets.flatMap((memoryTarget, index) => [
      ...(index > 0 ? [""] : []),
      `# ${memoryTarget === "user" ? "User" : "Workspace"} memory`,
      "",
      this.options.loadMemory(memoryTarget).trim() || "No saved memory.",
    ]);

    this.contentViewer.open({
      title: "Memory",
      render: () => content,
    });
  }

  private showHelp(): void {
    const lines = [
      COMMAND_MESSAGES.helpTitle,
      "",
      ...PROMPT_COMMANDS.map((command) => `/${command.name.padEnd(8)} ${command.description}`),
      "",
      COMMAND_MESSAGES.shellShortcutsTitle,
      "",
      COMMAND_MESSAGES.shellShortcut,
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
    this.contentViewer.close();
    this.agent = this.createAgentForCurrentSession();
    this.agentEvents.resetRun();
    this.transcript.clear();
    this.editor.clear();
    this.initializeTranscript([]);
    this.updateContextUsageFromMessages([]);
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
    this.contentViewer.close();
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
    this.contentViewer.close();
    this.sessionOverlay.openResume();
  }

  private openDeletePicker(): void {
    if (this.running) {
      return;
    }

    this.skillManager.close();
    this.contentViewer.close();
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
    this.contentViewer.close();
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
    this.contentViewer.close();
    this.sessionId = session.id;
    this.agent.abort();
    this.agent = this.createAgentForCurrentSession();
    this.agentEvents.resetRun();
    this.transcript.clear();
    this.editor.clear();
    this.initializeTranscript(session.messages);
    this.updateContextUsageFromMessages(session.messages);
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
        this.notifications.handleAgentEvent(event);
        if (event.type === "message_end") {
          this.recordUsage(event.message.usage);
        }
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

  private async submitShellCommand(command: string): Promise<void> {
    const shellCommand = command.trim();

    if (!shellCommand || this.running) {
      return;
    }

    await this.localShell.submit(shellCommand);
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

  private recordUsage(usage: ModelUsage | undefined): void {
    if (!usage) {
      return;
    }

    const metadata = this.agent.state.model.metadata;

    this.totalUsage = addModelUsage(this.totalUsage, usage);
    this.totalCostCny += calculateUsageCostCny(usage, metadata.cost);
    this.updateContextUsage(usage);
  }

  private updateContextUsageFromMessages(messages: Message[]): void {
    this.updateContextUsage(findLatestAssistantUsage(messages));
  }

  private updateContextUsage(usage: ModelUsage | undefined): void {
    this.status.update({
      contextUsedPercent: calculateContextUsedPercent(
        usage,
        this.agent.state.model.metadata.contextWindow,
      ),
    });
  }
}

function formatModelName(metadata: ModelMetadata): string {
  return `${metadata.provider}/${metadata.model}`;
}

function formatCny(amount: number): string {
  return `¥${amount.toFixed(4)}`;
}

function formatExitLine(label: string, value: string): string {
  return `${`${label}:`.padEnd(13)}${value}`;
}

function formatModelUsage(usage: ModelUsage): string {
  const cachedTokens = usage.promptCacheHitTokens ?? 0;
  const inputTokens = usage.promptCacheMissTokens ?? Math.max(0, usage.promptTokens - cachedTokens);
  const totalTokens = inputTokens + usage.completionTokens;

  return [
    `total=${formatInteger(totalTokens)}`,
    `input=${formatInteger(inputTokens)}`,
    cachedTokens > 0 ? `(+ ${formatInteger(cachedTokens)} cached)` : undefined,
    `output=${formatInteger(usage.completionTokens)}`,
    usage.reasoningTokens === undefined
      ? undefined
      : `(reasoning ${formatInteger(usage.reasoningTokens)})`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}
