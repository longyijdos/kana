import type {
  Agent,
  BeforeToolExecutionHook,
  BeforeToolExecutionResult,
  ContextCheckpoint,
} from "@/agent";
import {
  addModelUsage,
  calculateUsageCostCny,
  type Message,
  type ModelMetadata,
  type ModelUsage,
  type ToolCallContent,
  type UserImage,
  type UserMessage,
} from "@/core";
import type {
  KanaLaunchMode,
  KanaMcpServerActivation,
  KanaNotificationConfig,
  KanaOAuthTokenStatus,
  KanaSessionMetadata,
  KanaToolApprovalConfig,
  KanaToolApprovalMode,
  KanaToolApprovals,
  KanaTuiConfig,
  KanaUsageScope,
  KanaUsageSummary,
  LoadKanaSkillActivationsResult,
  WakeScheduler,
} from "@/kana";
import {
  ConversationRuntime,
  type ConversationRuntimeEvent,
  type ConversationSessionSnapshot,
} from "@/kana";
import { createNoopLogger, type Logger } from "@/logging";
import type { McpOAuthHttpDiagnosticEvent } from "@/mcp";
import { loadUserImageFile } from "@/utils";
import { readClipboardImage } from "../clipboard-image";
import {
  Editor,
  MarkdownBlock,
  type StatusLineState,
  TextBlock,
  Transcript,
  UsageSummaryBlock,
  UserMessageBlock,
} from "../components";
import {
  formatPromptCommandHelpLine,
  formatPromptShortcutHelpLine,
  PROMPT_COMMANDS,
  PROMPT_HELP_TITLE,
  PROMPT_SHORTCUTS,
  PROMPT_SHORTCUTS_TITLE,
} from "../components/editor/commands";
import { stripTerminalControlSequences } from "../render";
import type { Terminal } from "../runtime";
import { isCtrlC, isCtrlO, isEscape, Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { ToolApprovalSource } from "../tools";
import { calculateContextUsedPercent } from "../utils/context-usage";
import { preloadSyntaxHighlighter } from "../utils/syntax-highlighter";
import { AgentEventRenderer } from "./agent-event-renderer";
import { AppLayout } from "./app-layout";
import { ContentViewerController } from "./content-viewer-controller";
import {
  ExternalToolsLifecycleController,
  type ExternalToolsLoadResult,
} from "./external-tools-lifecycle-controller";
import { LocalShellController } from "./local-shell-controller";
import { McpServerManagerController } from "./mcp-server-manager-controller";
import {
  MemoryCompactController,
  type MemoryCompactSummary,
  type MemoryScope,
} from "./memory-compact-controller";
import {
  formatTuiReasoningSelection,
  type TuiModelSelection,
  type TuiModelSettings,
} from "./model-selection";
import { NotificationController } from "./notification-controller";
import { QueuedInputController } from "./queued-input-controller";
import { ScheduledMessageManagerController } from "./scheduled-message-manager-controller";
import { SessionLifecycleController } from "./session-lifecycle-controller";
import { SkillManagerController } from "./skill-manager-controller";
import { type SlashCommand, SlashCommandController } from "./slash-command-controller";
import {
  formatToolApprovalMode,
  SlashCommandOptionsController,
} from "./slash-command-options-controller";
import type { RunPhase } from "./status-phase";
import { ToolApprovalController } from "./tool-approval-controller";

export type KanaTuiSessionSnapshot = ConversationSessionSnapshot;

export type KanaTuiExternalToolsLoadResult = ExternalToolsLoadResult;

export type KanaTuiAppOptions = {
  launchMode?: KanaLaunchMode;
  initialSession?: KanaTuiSessionSnapshot;
  initialPrompt?: string;
  getResumeSessionId: () => string | undefined;
  createNewSession: () => { id: string };
  forkSession: (
    messages: Message[],
    contextCheckpoint: ContextCheckpoint | undefined,
    prompt: string,
  ) => { id: string };
  listSessions: () => KanaSessionMetadata[];
  loadSession: (sessionId: string) => KanaTuiSessionSnapshot;
  deleteSession: (sessionId: string) => boolean;
  loadSkills: () => LoadKanaSkillActivationsResult;
  saveEnabledGlobalSkills: (names: string[]) => void;
  startInResumePicker?: boolean;
  toolApproval: {
    config: KanaToolApprovalConfig;
    approvals: KanaToolApprovals;
    resolveToolSource?: (toolName: string) => ToolApprovalSource | undefined;
  };
  notification: KanaNotificationConfig;
  tuiConfig?: KanaTuiConfig;
  wakeScheduler?: WakeScheduler;
  getLogger?: () => Logger;
  compactMemory: (
    target: MemoryScope,
    userRequest: string | undefined,
    signal: AbortSignal,
  ) => Promise<MemoryCompactSummary[]>;
  loadMemory: (target: Exclude<MemoryScope, "both">) => string;
  loadUsage: (scope: KanaUsageScope) => KanaUsageSummary;
  modelManagement?: {
    getSettings: () => TuiModelSettings;
  };
  loadExternalTools?: (
    onProgress: (status: string) => void,
  ) => Promise<KanaTuiExternalToolsLoadResult>;
  mcpManagement?: {
    loadServers: () => KanaMcpServerActivation[];
    saveEnabledServerIds: (serverIds: string[]) => void;
    authorizeServer?(
      serverId: string,
      onAuthorizationUrl: (url: string) => void,
      signal: AbortSignal,
    ): Promise<KanaOAuthTokenStatus>;
    signOutServer?(serverId: string): Promise<KanaOAuthTokenStatus>;
    reloadExternalTools: (
      onProgress: (status: string) => void,
    ) => Promise<KanaTuiExternalToolsLoadResult>;
  };
  onStop?: () => Promise<void> | void;
  onForceStop?: () => void;
};

export class KanaTuiApp {
  private readonly tui: Tui;
  private readonly transcript = new Transcript();
  private readonly editor: Editor;
  private readonly shutdownStatus = new TextBlock("", { color: tuiTheme.muted });
  private readonly layout: AppLayout;
  private readonly agentEvents: AgentEventRenderer;
  private readonly sessions: SessionLifecycleController;
  private readonly skillManager: SkillManagerController;
  private readonly mcpServerManager?: McpServerManagerController;
  private readonly conversation: ConversationRuntime<TuiModelSelection>;
  private readonly queuedInputs: QueuedInputController;
  private readonly scheduledMessageManager: ScheduledMessageManagerController;
  private running = false;
  private totalUsage?: ModelUsage;
  private totalCostCny = 0;
  private readonly toolApproval: ToolApprovalController;
  private readonly localShell: LocalShellController;
  private readonly contentViewer: ContentViewerController;
  private readonly slashCommands: SlashCommandController;
  private readonly slashCommandOptions: SlashCommandOptionsController;
  private readonly notifications: NotificationController;
  private readonly memoryCompact: MemoryCompactController;
  private readonly externalTools: ExternalToolsLifecycleController;
  private readonly hyperlinks: boolean;
  private readonly getLogger: () => Logger;
  private readonly unsubscribeConversationEvents: () => void;
  private contextCompactingBlock?: TextBlock;
  private readonly mcpOAuthBlocks = new Map<string, TextBlock>();
  private clipboardPasteRunning = false;
  private imageFileAttachRunning = false;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private resolveStopped!: () => void;
  private readonly stoppedPromise = new Promise<void>((resolve) => {
    this.resolveStopped = resolve;
  });

  constructor(
    createAgent: (options: {
      beforeToolExecution: BeforeToolExecutionHook;
      messages?: Message[];
      sessionId?: string;
      contextCheckpoint?: ContextCheckpoint;
      modelSelection?: TuiModelSelection;
    }) => Agent,
    terminal: Terminal,
    private readonly options: KanaTuiAppOptions,
  ) {
    const initialSession = options.initialSession;
    const cleanMode = options.launchMode === "clean";
    this.getLogger = options.getLogger ?? createNoopLogger;
    // The config enables the feature but never forces OSC 8 through a terminal
    // that the runtime could not positively identify as hyperlink-capable.
    this.hyperlinks =
      (options.tuiConfig?.hyperlinks ?? true) && terminal.supportsHyperlinks === true;
    this.conversation = new ConversationRuntime<TuiModelSelection>({
      initialSession,
      createAgent: ({ configuration, ...agentOptions }) =>
        createAgent({
          ...agentOptions,
          modelSelection: configuration,
        }),
      createNewSession: options.createNewSession,
      forkSession: options.forkSession,
      loadSession: options.loadSession,
      listSessions: options.listSessions,
      deleteSession: options.deleteSession,
      wakeScheduler: options.wakeScheduler,
      canStartQueuedRun: () =>
        !this.running &&
        !this.externalTools.loading &&
        !this.mcpServerManager?.active &&
        !this.scheduledMessageManager?.active &&
        !this.stopping,
      getLogger: this.getLogger,
    });
    this.tui = new Tui(terminal);
    this.notifications = new NotificationController(options.notification, terminal);
    this.editor = new Editor({
      cleanMode: options.launchMode === "clean",
      collapseLongPastes: options.tuiConfig?.collapseLongPastes ?? true,
      model: formatStatusModel(
        this.conversation.state.model.metadata,
        this.options.modelManagement?.getSettings(),
      ),
    });
    this.queuedInputs = new QueuedInputController((inputs, scheduled) => {
      this.editor.setQueuedInputs(inputs);
      this.editor.setScheduledInputSummary(scheduled);
      this.tui.requestRender();
    });
    this.queuedInputs.syncRuntimeQueue(this.conversation.inputQueue);
    this.layout = new AppLayout({
      main: this.transcript,
      bottom: this.editor,
    });
    this.agentEvents = new AgentEventRenderer({
      transcript: this.transcript,
      tui: this.tui,
      hyperlinks: this.hyperlinks,
      smoothTextStreaming: options.tuiConfig?.smoothTextStreaming ?? true,
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.externalTools = new ExternalToolsLifecycleController({
      transcript: this.transcript,
      tui: this.tui,
      load: cleanMode ? undefined : this.options.loadExternalTools,
      reload: cleanMode ? undefined : this.options.mcpManagement?.reloadExternalTools,
      isStopping: () => this.stopping,
      onToolsChanged: () => this.recreateAgentForExternalTools(),
      onReady: () => this.conversation.notifyCanStartQueuedRun(),
      updateStatus: (phase) => this.updateStatus(phase, { activeTool: undefined }),
      focusEditor: () => this.tui.setFocus(this.editor),
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
      restoreBottom: (focus) => this.restoreBottom(focus),
    });
    if (!cleanMode && this.options.mcpManagement) {
      this.mcpServerManager = new McpServerManagerController({
        editor: this.editor,
        layout: this.layout,
        transcript: this.transcript,
        tui: this.tui,
        loadServers: this.options.mcpManagement.loadServers,
        saveEnabledServerIds: this.options.mcpManagement.saveEnabledServerIds,
        authorizeServer: this.options.mcpManagement.authorizeServer,
        signOutServer: this.options.mcpManagement.signOutServer,
        onClose: (changed) => {
          if (changed) {
            void this.externalTools.reload();
          } else {
            this.conversation.notifyCanStartQueuedRun();
          }
        },
        updateStatus: (phase, extra) => this.updateStatus(phase, extra),
        restoreBottom: (focus) => this.restoreBottom(focus),
      });
    }
    this.contentViewer = new ContentViewerController({
      layout: this.layout,
      transcript: this.transcript,
      tui: this.tui,
      restoreBottom: (focus) => this.restoreBottom(focus),
    });
    this.scheduledMessageManager = new ScheduledMessageManagerController({
      editor: this.editor,
      layout: this.layout,
      tui: this.tui,
      getQueue: () => this.conversation.inputQueue,
      schedule: (afterMinutes, message) => this.conversation.scheduleInput(afterMinutes, message),
      cancel: (id) => this.conversation.cancelScheduledInput(id),
      showError: (error) => this.showError(error),
      collapseLongPastes: options.tuiConfig?.collapseLongPastes ?? true,
      restoreBottom: (focus) => this.restoreBottom(focus),
      onClose: () => this.conversation.notifyCanStartQueuedRun(),
    });
    this.slashCommandOptions = new SlashCommandOptionsController({
      editor: this.editor,
      layout: this.layout,
      tui: this.tui,
      onUsageScope: (scope) => this.showUsage(scope),
      onMemoryShow: (scope) => this.openMemoryViewer(scope),
      onMemoryCompact: (scope, request) => {
        this.restoreBottom(true);
        void this.memoryCompact.compact(scope, request);
      },
      getApprovalMode: () => this.toolApproval.mode,
      onApprovalModeSelect: (mode) => {
        this.restoreBottom(true);
        this.setToolApprovalMode(mode);
      },
      collapseLongPastes: options.tuiConfig?.collapseLongPastes ?? true,
      getModelSettings: this.options.modelManagement?.getSettings,
      onModelSelect: (selection) => {
        this.restoreBottom(true);
        this.switchModel(selection);
      },
      restoreBottom: (focus) => this.restoreBottom(focus),
    });
    this.toolApproval = new ToolApprovalController({
      ...options.toolApproval,
      editor: this.editor,
      layout: this.layout,
      tui: this.tui,
      onApprovalRequired: (toolName) => {
        this.updateStatus("tool", {
          activeTool: toolName,
        });
        this.notifications.approvalRequired(toolName);
      },
    });
    this.conversation.setBeforeToolExecution(({ toolCall, signal }) =>
      this.showToolApprovalPrompt(toolCall, signal),
    );
    this.localShell = new LocalShellController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      setRunning: (running) => {
        this.running = running;
      },
      clearRunStatus: () => this.clearAuxiliaryRunStatus(),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
      getLogger: this.getLogger,
    });
    this.memoryCompact = new MemoryCompactController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      compactMemory: this.options.compactMemory,
      setRunning: (running) => {
        this.running = running;
      },
      clearRunStatus: () => this.clearAuxiliaryRunStatus(),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
      getLogger: this.getLogger,
    });
    this.sessions = new SessionLifecycleController({
      conversation: this.conversation,
      editor: this.editor,
      layout: this.layout,
      transcript: this.transcript,
      tui: this.tui,
      hyperlinks: this.hyperlinks,
      isRunning: () => this.running,
      closeOtherOverlays: () => {
        this.skillManager.close();
        this.scheduledMessageManager.close();
      },
      closeContentViewer: () => this.contentViewer.close(),
      resetAgentEvents: () => this.agentEvents.resetRun(),
      clearMcpOAuthBlocks: () => this.mcpOAuthBlocks.clear(),
      updateContextUsage: () => this.updateContextUsage(),
      updateStatus: (phase) => this.updateStatus(phase, { activeTool: undefined }),
      restoreBottom: (focus) => this.restoreBottom(focus),
      showError: (error) => this.showError(error),
      stop: () => {
        void this.stop();
      },
      submitPrompt: (prompt) => this.submitPrompt(prompt),
      activateSession: () => {
        void this.activateCurrentSession();
      },
      savedSessionsAvailable: !cleanMode,
    });
    this.slashCommands = new SlashCommandController({
      isRunning: () => this.running,
      stop: () => {
        void this.stop();
      },
      submitRaw: (raw) => {
        void this.submitPrompt(raw);
      },
      showError: (error) => this.showError(error),
      showHelp: () => this.showHelp(),
      clear: () => {
        this.contentViewer.close();
        this.transcript.clear();
        this.mcpOAuthBlocks.clear();
        this.editor.clear();
        this.tui.requestRender(true);
      },
      startNewSession: () => {
        this.editor.clear();
        this.sessions.startNew();
      },
      forkSession: (prompt) => {
        this.editor.clear();
        if (cleanMode) {
          this.showForkingUnavailable();
          return;
        }
        void this.forkSession(prompt);
      },
      resumeSession: (sessionId) => {
        if (cleanMode) {
          this.showSavedSessionsUnavailable();
          return;
        }
        this.sessions.resume(sessionId);
      },
      openResumePicker: () => {
        this.editor.clear();
        if (cleanMode) {
          this.showSavedSessionsUnavailable();
          return;
        }
        this.sessions.openResume();
      },
      openDeletePicker: () => {
        this.editor.clear();
        if (cleanMode) {
          this.showSavedSessionsUnavailable();
          return;
        }
        this.sessions.openDelete();
      },
      openSkillManager: () => {
        this.editor.clear();
        this.openSkillManager();
      },
      openMcpServerManager: () => {
        this.editor.clear();
        this.openMcpServerManager();
      },
      openScheduledMessageManager: () => {
        this.editor.clear();
        this.openScheduledMessageManager();
      },
      attachImageFile: (path) => {
        void this.attachImageFile(path);
      },
      openApproval: () => this.slashCommandOptions.openApproval(),
      openModel: () => this.slashCommandOptions.openModel(),
      openMemory: () => this.openMemory(),
      compactContext: () => {
        this.editor.clear();
        void this.compactContext();
      },
      openUsage: () => this.slashCommandOptions.openUsage(),
    });
    this.unsubscribeConversationEvents = this.conversation.subscribe((event) =>
      this.handleConversationEvent(event),
    );
    this.updateContextUsage();
  }

  start(): void {
    this.getLogger().info("tui.started", {
      launchMode: this.options.launchMode ?? "normal",
      resumed: this.conversation.sessionId !== undefined,
    });
    void preloadSyntaxHighlighter().then(
      () => this.tui.requestRender(),
      () => undefined,
    );

    if (!this.options.startInResumePicker) {
      this.sessions.initializeTranscript(this.options.initialSession?.timeline ?? []);
    }
    if (this.options.launchMode === "clean") {
      this.transcript.addChild(
        new TextBlock("Clean mode · temporary session; customizations and saving are disabled.", {
          color: tuiTheme.muted,
        }),
      );
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

      void this.submitPrompt(submit.content, submit.images);
    };
    this.editor.onQueue = (submit) => {
      if (submit.type === "message") {
        this.queuePrompt(submit.content, submit.images);
      }
    };
    this.editor.onPasteClipboard = () => {
      void this.pasteClipboard();
    };

    this.updateStatus("idle");
    this.tui.start();

    if (this.options.startInResumePicker) {
      this.sessions.openResume();
      return;
    }

    void this.activateCurrentSession(this.options.initialPrompt);
  }

  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopPromise ?? this.stoppedPromise;
    }

    this.stopping = true;
    this.stopPromise = this.stopInternal().finally(() => {
      this.resolveStopped();
    });
    return this.stopPromise;
  }

  waitForStop(): Promise<void> {
    return this.stoppedPromise;
  }

  showShutdownStatus(status: string): void {
    if (!this.stopping) {
      return;
    }

    this.shutdownStatus.setText(
      this.options.onForceStop === undefined
        ? status
        : `${status}\nPress Ctrl+C again to force quit.`,
    );
    if (!this.transcript.children.includes(this.shutdownStatus)) {
      this.transcript.addChild(this.shutdownStatus);
    }
    this.tui.setFocus(undefined);
    this.tui.requestRender(true);
  }

  showMcpOAuthAuthorization(serverId: string, authorizationUrl: string): void {
    const block = this.getMcpOAuthBlock(serverId);
    block.setText(
      [
        `Authorizing MCP server ${sanitizeLabel(serverId)} in your browser.`,
        "If the browser did not open, use this temporary URL:",
        authorizationUrl,
      ].join("\n"),
    );
    this.tui.requestRender(true);
  }

  handleMcpOAuthDiagnostic(serverId: string, diagnostic: McpOAuthHttpDiagnosticEvent): void {
    const block = this.mcpOAuthBlocks.get(serverId);
    if (block === undefined) {
      return;
    }
    if (diagnostic.event === "oauth.authorization_succeeded") {
      block.setText(`MCP OAuth authorized: ${sanitizeLabel(serverId)}.`);
      this.tui.requestRender(true);
    } else if (diagnostic.event === "oauth.authorization_failed") {
      block.setText(
        `MCP OAuth authorization failed: ${sanitizeLabel(serverId)}. See logs for details.`,
      );
      this.tui.requestRender(true);
    }
  }

  private getMcpOAuthBlock(serverId: string): TextBlock {
    const existing = this.mcpOAuthBlocks.get(serverId);
    if (existing !== undefined) {
      return existing;
    }
    const block = new TextBlock("", { color: tuiTheme.muted });
    this.mcpOAuthBlocks.set(serverId, block);
    this.transcript.addChild(block);
    return block;
  }

  private async stopInternal(): Promise<void> {
    this.getLogger().info("tui.stopped");
    this.localShell.abort();
    this.memoryCompact.abort();
    this.scheduledMessageManager.close();
    this.mcpServerManager?.close();
    this.unsubscribeConversationEvents();
    this.showShutdownStatus("Shutting down Kana...");
    const resumeSessionId = this.options.getResumeSessionId();
    const exitLines = [
      this.totalUsage
        ? formatExitLine("Token usage", formatModelUsage(this.totalUsage))
        : undefined,
      this.totalCostCny > 0 ? formatExitLine("API cost", formatCny(this.totalCostCny)) : undefined,
      resumeSessionId ? formatExitLine("Resume", `kana resume ${resumeSessionId}`) : undefined,
    ].filter((line): line is string => Boolean(line));

    // An MCP tools/call must observe Agent cancellation before its transport is
    // closed. Otherwise shutdown can turn a normal abort into an unrelated
    // connection error and leave the server uncertain about cancellation.
    try {
      await this.conversation.close();
    } catch (error) {
      this.getLogger().error("tui.agent_shutdown_failed", { error });
    }

    try {
      await this.options.onStop?.();
    } catch (error) {
      this.getLogger().error("tui.shutdown_failed", { error });
    }

    exitLines.length > 0 ? this.tui.stop(exitLines.join("\r\n")) : this.tui.stop();
  }

  private async activateCurrentSession(initialPrompt?: string): Promise<void> {
    const ready = await this.externalTools.load();

    if (ready && initialPrompt && !this.stopping) {
      await this.submitPrompt(initialPrompt);
    }
  }

  private recreateAgentForExternalTools(): void {
    // The editor is unfocused before initial load or reload begins, and the
    // MCP manager menu cannot open during a run, so replacement is race-free.
    this.conversation.reconfigure();
    this.agentEvents.resetRun();
    this.updateContextUsage();
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (this.stopping) {
      if (isCtrlC(data)) {
        this.getLogger().warn("tui.force_stop_requested");
        this.options.onForceStop?.();
      }
      return { consume: true };
    }

    if (this.externalTools.loading) {
      if (isCtrlC(data)) {
        void this.stop();
      }
      return { consume: true };
    }

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

      void this.stop();
      return { consume: true };
    }

    if (isEscape(data) && this.running) {
      this.abort();
      return { consume: true };
    }

    return undefined;
  }

  private abort(): void {
    this.getLogger().info("tui.abort_requested");
    if (this.localShell.abort()) {
      return;
    }

    if (this.memoryCompact.abort()) {
      return;
    }

    this.conversation.abort();
    this.updateStatus("aborted");
  }

  private handleCommand(command: SlashCommand): void {
    this.slashCommands.handle(command);
  }

  private switchModel(selection: TuiModelSelection): void {
    const logMetadata = {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: formatTuiReasoningSelection(selection),
    };
    this.getLogger().info("tui.model_switch_started", logMetadata);

    try {
      this.conversation.reconfigure(selection);
      this.editor.setModel(
        `${this.conversation.state.model.metadata.model} · ${formatTuiReasoningSelection(selection)}`,
      );
      this.updateContextUsage();
      this.transcript.addChild(
        new TextBlock(
          `Switched to ${formatModelName(this.conversation.state.model.metadata)} · reasoning ${formatTuiReasoningSelection(selection)}.`,
          { color: tuiTheme.muted },
        ),
      );
      this.updateStatus("idle", { activeTool: undefined });
      this.getLogger().info("tui.model_switch_completed", logMetadata);
    } catch (error) {
      this.getLogger().error("tui.model_switch_failed", {
        ...logMetadata,
        error,
      });
      this.showError(error);
    }

    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);
  }

  private openMemoryViewer(target: MemoryScope): void {
    const memoryTargets =
      target === "both" ? (["global", "project"] as const) : ([target] as const);
    const markdown = new MarkdownBlock(
      memoryTargets
        .flatMap((memoryTarget, index) => [
          ...(index > 0 ? [""] : []),
          `# ${memoryTarget === "global" ? "Global" : "Project"} memory`,
          "",
          this.options.loadMemory(memoryTarget).trim() || "No saved memory.",
        ])
        .join("\n"),
      { hyperlinks: this.hyperlinks },
    );

    this.contentViewer.open({
      title: "Memory",
      render: (contentWidth) => markdown.render(contentWidth),
    });
  }

  private showUsage(scope: KanaUsageScope): void {
    if (this.options.launchMode === "clean" && scope === "session") {
      this.showError(new Error("Session usage is unavailable in clean mode."));
      return;
    }
    const summary = this.options.loadUsage(scope);
    const usage = new UsageSummaryBlock(summary);
    this.editor.clear();
    this.contentViewer.open({
      title: `Usage · ${summary.scope}`,
      render: (contentWidth) => usage.render(contentWidth),
    });
    this.updateStatus("idle", { activeTool: undefined });
  }

  private showHelp(): void {
    const help = new TextBlock(
      [
        ...PROMPT_COMMANDS.map(formatPromptCommandHelpLine),
        "",
        PROMPT_SHORTCUTS_TITLE,
        "",
        ...PROMPT_SHORTCUTS.map(formatPromptShortcutHelpLine),
      ].join("\n"),
      { color: tuiTheme.muted },
    );

    this.editor.clear();
    this.contentViewer.open({
      title: PROMPT_HELP_TITLE,
      render: (contentWidth) => help.render(contentWidth),
    });
    this.updateStatus("idle", {
      activeTool: undefined,
    });
  }

  private async forkSession(prompt: string): Promise<void> {
    await this.sessions.fork(prompt);
  }

  private refreshAgentSystemPrompt(): void {
    this.conversation.reconfigure();
  }

  private openSkillManager(): void {
    if (this.options.launchMode === "clean") {
      this.showError(new Error("Skills are unavailable in clean mode."));
      return;
    }
    if (this.running) {
      return;
    }

    this.sessions.close();
    this.contentViewer.close();
    this.scheduledMessageManager.close();
    this.skillManager.open();
  }

  private openMcpServerManager(): void {
    if (this.options.launchMode === "clean") {
      this.showError(new Error("MCP management is unavailable in clean mode."));
      return;
    }
    if (this.running) {
      return;
    }
    if (!this.mcpServerManager) {
      this.showError(new Error("MCP management is unavailable."));
      return;
    }

    this.sessions.close();
    this.contentViewer.close();
    this.skillManager.close();
    this.scheduledMessageManager.close();
    this.mcpServerManager.open();
  }

  private openScheduledMessageManager(): void {
    if (this.running) {
      return;
    }

    this.sessions.close();
    this.contentViewer.close();
    this.skillManager.close();
    this.mcpServerManager?.close();
    this.scheduledMessageManager.open();
  }

  private openMemory(): void {
    if (this.options.launchMode === "clean") {
      this.editor.clear();
      this.showError(new Error("Memory is unavailable in clean mode."));
      return;
    }

    this.slashCommandOptions.openMemory();
  }

  private showSavedSessionsUnavailable(): void {
    this.showError(new Error("Saved sessions are unavailable in clean mode."));
  }

  private showForkingUnavailable(): void {
    this.showError(new Error("Forking sessions is unavailable in clean mode."));
  }

  private handleConversationEvent(event: ConversationRuntimeEvent): void {
    switch (event.type) {
      case "run_start":
        this.running = true;
        this.agentEvents.resetRun();
        if (event.source === "user" && event.input) {
          this.transcript.addChild(new UserMessageBlock(event.input));
        } else if (event.source === "scheduled" && event.input) {
          this.transcript.addChild(
            new TextBlock(`Scheduled wake: ${formatScheduledWakeContent(event.input.content)}`, {
              color: tuiTheme.muted,
            }),
          );
        }
        this.updateStatus(event.source === "compaction" ? "compacting" : "starting");
        this.tui.requestRender();
        break;

      case "agent_event":
        if (event.event.type === "context_compacted" && this.contextCompactingBlock !== undefined) {
          this.transcript.removeChild(this.contextCompactingBlock);
          this.contextCompactingBlock = undefined;
        }
        if (event.event.type === "turn_input") {
          this.queuedInputs.deliverTurn(event.event.message);
        }
        this.agentEvents.handle(event.event);
        if (event.source !== "compaction") {
          this.notifications.handleAgentEvent(event.event);
        }
        if (event.event.type === "message_end") {
          this.recordUsage(event.event.message.usage);
        } else if (event.event.type === "turn_end") {
          this.updateContextUsage(event.event.estimatedContextTokens);
          this.tui.requestRender();
        } else if (event.event.type === "context_compacted") {
          this.recordUsage(event.event.usage);
        }
        break;

      case "run_end":
        this.finishConversationRun();
        break;

      case "run_error":
        this.showError(event.error);
        this.finishConversationRun();
        break;

      case "session_changed":
        this.queuedInputs.clear();
        if (this.toolApproval.resetTemporaryMode() !== undefined) {
          this.getLogger().info("tui.tool_approval_mode_reset", {
            action: event.action,
            mode: this.toolApproval.mode,
          });
        }
        break;

      case "input_queue_changed":
        this.queuedInputs.syncRuntimeQueue(event.queue);
        break;
    }
  }

  private finishConversationRun(): void {
    this.running = false;
    this.updateContextUsage();
    this.editor.updateStatus({
      running: false,
      activeTool: undefined,
    });
    this.tui.requestRender();
  }

  private setToolApprovalMode(mode: KanaToolApprovalMode): void {
    const previousMode = this.toolApproval.mode;
    this.toolApproval.setTemporaryMode(mode);
    const currentMode = this.toolApproval.mode;

    this.transcript.addChild(
      new TextBlock(
        `Tool approval mode for this session: ${formatToolApprovalMode(currentMode)}.`,
        {
          color: tuiTheme.muted,
        },
      ),
    );
    this.updateStatus("idle", { activeTool: undefined });
    this.getLogger().info("tui.tool_approval_mode_changed", {
      previousMode,
      mode: currentMode,
      scope: "session",
    });
    this.tui.requestRender();
  }

  private showError(error: unknown): void {
    this.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
      }),
    );
    this.updateStatus("error");
  }

  private async submitPrompt(value: string, images: UserImage[] = []): Promise<void> {
    const prompt = value.trim();

    if (!prompt && images.length === 0) {
      return;
    }
    const imageInputError = this.getImageInputError(images);
    if (imageInputError) {
      this.showError(imageInputError);
      return;
    }
    const input: UserMessage = {
      role: "user",
      content: prompt,
      ...(images.length > 0 ? { images: structuredClone(images) } : {}),
    };

    if (this.conversation.canSteer) {
      this.editor.addToHistory(prompt);
      this.editor.clear();
      const queuedInputId = this.queuedInputs.addTurn(input);
      const disposition = await this.conversation.steer(input);
      if (disposition !== "queued") {
        this.queuedInputs.remove(queuedInputId);
      }
      return;
    }
    if (this.running) {
      return;
    }

    this.editor.addToHistory(prompt);
    this.editor.clear();
    await this.submitAgentInput(input);
  }

  private queuePrompt(value: string, images: UserImage[] = []): void {
    const prompt = value.trim();
    if ((!prompt && images.length === 0) || !this.conversation.canSteer) {
      return;
    }
    const imageInputError = this.getImageInputError(images);
    if (imageInputError) {
      this.showError(imageInputError);
      return;
    }
    const input: UserMessage = {
      role: "user",
      content: prompt,
      ...(images.length > 0 ? { images: structuredClone(images) } : {}),
    };

    this.editor.addToHistory(prompt);
    this.editor.clear();
    this.conversation.queueInput(input);
  }

  private async pasteClipboard(): Promise<void> {
    if (this.clipboardPasteRunning) {
      return;
    }

    this.clipboardPasteRunning = true;
    try {
      const image = await readClipboardImage();
      if (image) {
        const imageInputError = this.getImageInputError([image]);
        if (imageInputError) {
          throw imageInputError;
        }
        this.editor.attachImage(image);
        try {
          this.getLogger().debug("tui.clipboard_paste_completed", {
            contentType: "image",
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
          });
        } catch {
          // Clipboard diagnostics must not change attachment behavior.
        }
        return;
      }

      throw new Error("The clipboard does not contain an image.");
    } catch (error) {
      try {
        this.getLogger().warn("tui.clipboard_paste_failed", {
          platform: process.platform,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Clipboard diagnostics must not replace the user-facing failure.
      }
      this.showError(error);
    } finally {
      this.clipboardPasteRunning = false;
      this.tui.requestRender();
    }
  }

  private async attachImageFile(path: string): Promise<void> {
    if (this.imageFileAttachRunning) {
      return;
    }

    this.imageFileAttachRunning = true;
    try {
      const imageInputError = this.getImageInputAvailabilityError();
      if (imageInputError) {
        throw imageInputError;
      }
      const image = await loadUserImageFile(path);
      this.editor.attachImage(image);
      this.editor.setText("");
      try {
        this.getLogger().debug("tui.image_file_attach_completed", {
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
        });
      } catch {
        // Image diagnostics must not change attachment behavior.
      }
    } catch (error) {
      try {
        this.getLogger().warn("tui.image_file_attach_failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Image diagnostics must not replace the user-facing failure.
      }
      this.showError(error);
    } finally {
      this.imageFileAttachRunning = false;
      this.tui.requestRender();
    }
  }

  private getImageInputError(images: readonly UserImage[]): Error | undefined {
    if (images.length === 0) {
      return undefined;
    }

    return this.getImageInputAvailabilityError();
  }

  private getImageInputAvailabilityError(): Error | undefined {
    const metadata = this.conversation.state.model.metadata;
    if (metadata.supportsImageInput !== true) {
      return new Error(`Model ${metadata.model} does not support image input.`);
    }

    const settings = this.options.modelManagement?.getSettings();
    if (!settings || settings.activeProvider !== metadata.provider) {
      return undefined;
    }
    const enabled =
      settings.activeProvider === "deepseek"
        ? settings.model.deepseek.imageInput === true
        : settings.model["openai-codex"].imageInput !== false;
    return enabled ? undefined : new Error("Image input is disabled in the active model config.");
  }

  private async submitAgentInput(input: Extract<Message, { role: "user" }>): Promise<void> {
    if (this.stopping || this.externalTools.loading) {
      return;
    }

    try {
      await this.conversation.submit(input);
    } catch {
      // The runtime publishes run_error before rejecting the submit promise.
    }
  }

  private async compactContext(): Promise<void> {
    if (this.stopping || this.externalTools.loading) {
      return;
    }

    const compactingBlock = new TextBlock("Compacting context…", {
      color: tuiTheme.muted,
    });
    this.contextCompactingBlock = compactingBlock;
    this.transcript.addChild(compactingBlock);
    this.tui.requestRender();

    try {
      await this.conversation.compact();
    } catch {
      // The runtime publishes run_error before rejecting the compact promise.
    } finally {
      this.transcript.removeChild(compactingBlock);
      if (this.contextCompactingBlock === compactingBlock) {
        this.contextCompactingBlock = undefined;
      }
      this.tui.requestRender();
    }
  }

  private async submitShellCommand(command: string): Promise<void> {
    const shellCommand = command.trim();

    if (!shellCommand || this.running || this.externalTools.loading) {
      return;
    }

    await this.localShell.submit(shellCommand);
  }

  private clearAuxiliaryRunStatus(): void {
    this.editor.updateStatus({
      running: false,
      activeTool: undefined,
    });
    this.conversation.notifyCanStartQueuedRun();
  }

  private showToolApprovalPrompt(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    this.agentEvents.prepareForToolInteraction();
    return this.toolApproval.request(toolCall, signal);
  }

  private restoreBottom(focus: boolean): void {
    const bottom = this.toolApproval.activePrompt ?? this.editor;

    this.layout.showBottom(bottom);
    if (focus) {
      this.tui.setFocus(bottom);
    }
    this.tui.requestRender(true);
  }

  private updateStatus(phase: RunPhase, extra: Partial<StatusLineState> = {}): void {
    this.editor.updateStatus({
      phase,
      running: this.running,
      ...extra,
    });
  }

  private recordUsage(usage: ModelUsage | undefined): void {
    if (!usage) {
      return;
    }

    const metadata = this.conversation.state.model.metadata;

    this.totalUsage = addModelUsage(this.totalUsage, usage);
    this.totalCostCny += calculateUsageCostCny(usage, metadata.cost);
  }

  private updateContextUsage(estimatedTokens?: number): void {
    const state = this.conversation.state;
    this.editor.updateStatus({
      contextUsedPercent: calculateContextUsedPercent(
        estimatedTokens ?? state.estimatedContextTokens,
        state.contextLimit ?? state.model.metadata.contextWindow,
      ),
    });
  }
}

function formatModelName(metadata: ModelMetadata): string {
  return `${metadata.provider}/${metadata.model}`;
}

function formatStatusModel(metadata: ModelMetadata, settings?: TuiModelSettings): string {
  if (!settings || settings.activeProvider !== metadata.provider) {
    return metadata.model;
  }

  if (settings.activeProvider === "deepseek") {
    const model = settings.model.deepseek;
    if (model.name !== metadata.model) {
      return metadata.model;
    }
    return `${metadata.model} · ${model.thinking ? model.reasoningEffort : "off"}`;
  }

  const model = settings.model["openai-codex"];
  return model.name === metadata.model
    ? `${metadata.model} · ${model.reasoningEffort}`
    : metadata.model;
}

function formatScheduledWakeContent(content: string): string {
  return content.replace(/^\[Scheduled wake event\]\n/, "");
}

function sanitizeLabel(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
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
