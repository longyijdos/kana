import type {
  Agent,
  BeforeToolExecutionHook,
  BeforeToolExecutionResult,
  ContextCheckpoint,
} from "@/agent";
import { createUserMessage, type Message, type ToolCallContent, type UserImage } from "@/core";
import type { KanaToolApprovalMode } from "@/kana";
import { ConversationRuntime, type ConversationRuntimeEvent } from "@/kana";
import { createNoopLogger, type Logger } from "@/logging";
import type { McpOAuthHttpDiagnosticEvent } from "@/mcp";
import { Editor, TextBlock, Transcript, UserMessageBlock } from "../components";
import type { Terminal } from "../runtime";
import { isCtrlC, isCtrlO, Tui } from "../runtime";
import { tuiTheme } from "../theme";
import { renderTodoState } from "../tools";
import { preloadSyntaxHighlighter } from "../utils/syntax-highlighter";
import { AgentEventRenderer } from "./agent-event-renderer";
import { AppLayout } from "./app-layout";
import type { KanaTuiAppOptions } from "./app-options";
import { BackgroundJobManagerController } from "./background-job-manager-controller";
import { BottomAreaController } from "./bottom-area-controller";
import { ContentViewerController } from "./content-viewer-controller";
import { ContextCompactController } from "./context-compact-controller";
import { ExternalToolsLifecycleController } from "./external-tools-lifecycle-controller";
import { ImageAttachmentController } from "./image-attachment-controller";
import { InformationViewerController } from "./information-viewer-controller";
import { InteractionErrorReporter } from "./interaction-error-reporter";
import { LocalShellController } from "./local-shell-controller";
import { McpOAuthStatusController } from "./mcp-oauth-status-controller";
import { McpServerManagerController } from "./mcp-server-manager-controller";
import { MemoryCompactController } from "./memory-compact-controller";
import type { TuiModelSelection } from "./model-selection";
import { formatStatusModel, ModelSelectionController } from "./model-selection-controller";
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
import { StatusProjectionController } from "./status-projection-controller";
import { ToolApprovalController } from "./tool-approval-controller";
import { ToolHistoryController } from "./tool-history-controller";

export type { KanaTuiAppOptions } from "./app-options";

export class KanaTuiApp {
  private readonly tui: Tui;
  private readonly transcript = new Transcript();
  private readonly editor: Editor;
  private readonly shutdownStatus = new TextBlock("", { color: tuiTheme.muted });
  private readonly layout: AppLayout;
  private readonly bottomArea: BottomAreaController;
  private readonly agentEvents: AgentEventRenderer;
  private readonly sessions: SessionLifecycleController;
  private readonly skillManager: SkillManagerController;
  private readonly mcpServerManager?: McpServerManagerController;
  private readonly conversation: ConversationRuntime<TuiModelSelection>;
  private readonly queuedInputs: QueuedInputController;
  private readonly scheduledMessageManager: ScheduledMessageManagerController;
  private readonly backgroundJobManager: BackgroundJobManagerController;
  private readonly status: StatusProjectionController;
  private readonly errors: InteractionErrorReporter;
  private readonly toolApproval: ToolApprovalController;
  private readonly localShell: LocalShellController;
  private readonly contentViewer: ContentViewerController;
  private readonly toolHistory: ToolHistoryController;
  private readonly slashCommands: SlashCommandController;
  private readonly slashCommandOptions: SlashCommandOptionsController;
  private readonly notifications: NotificationController;
  private readonly memoryCompact: MemoryCompactController;
  private readonly contextCompact: ContextCompactController;
  private readonly imageAttachments: ImageAttachmentController;
  private readonly informationViewer: InformationViewerController;
  private readonly modelSelection: ModelSelectionController;
  private readonly mcpOAuthStatus: McpOAuthStatusController;
  private readonly externalTools: ExternalToolsLifecycleController;
  private readonly hyperlinks: boolean;
  private readonly renderLatex: boolean;
  private readonly renderMermaid: boolean;
  private readonly getLogger: () => Logger;
  private readonly unsubscribeConversationEvents: () => void;
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
    const initialSession = options.conversation.initialSession;
    const cleanMode = options.launch.mode === "clean";
    this.getLogger = options.diagnostics?.getLogger ?? createNoopLogger;
    // The config enables the feature but never forces OSC 8 through a terminal
    // that the runtime could not positively identify as hyperlink-capable.
    this.hyperlinks =
      (options.ui.config?.hyperlinks ?? true) && terminal.supportsHyperlinks === true;
    this.renderLatex = options.ui.config?.renderLatex ?? true;
    this.renderMermaid = options.ui.config?.renderMermaid ?? true;
    this.conversation = new ConversationRuntime<TuiModelSelection>({
      initialSession,
      createAgent: ({ configuration, ...agentOptions }) =>
        createAgent({
          ...agentOptions,
          modelSelection: configuration,
        }),
      createNewSession: options.conversation.createNewSession,
      forkSession: options.conversation.forkSession,
      loadSession: options.conversation.loadSession,
      listSessions: options.conversation.listSessions,
      deleteSession: options.conversation.deleteSession,
      wakeScheduler: options.conversation.wakeScheduler,
      goalMaxRounds: options.conversation.goalMaxRounds,
      getBackgroundJobs: options.conversation.getBackgroundJobs,
      disposeSession: options.conversation.disposeSession,
      canStartQueuedRun: () =>
        !this.status.running &&
        !this.externalTools.loading &&
        !this.mcpServerManager?.active &&
        !this.scheduledMessageManager?.active &&
        !this.backgroundJobManager?.active &&
        !this.stopping,
      getLogger: this.getLogger,
    });
    this.tui = new Tui(terminal);
    this.notifications = new NotificationController(options.ui.notification, terminal);
    this.editor = new Editor({
      cleanMode,
      collapseLongPastes: options.ui.config?.collapseLongPastes ?? true,
      model: formatStatusModel(
        this.conversation.state.model.metadata,
        this.options.models?.getSettings(),
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
    this.bottomArea = new BottomAreaController({
      layout: this.layout,
      tui: this.tui,
      fallback: this.editor,
    });
    this.status = new StatusProjectionController({
      editor: this.editor,
      getAgentState: () => this.conversation.state,
    });
    this.errors = new InteractionErrorReporter({
      transcript: this.transcript,
      tui: this.tui,
      status: this.status,
    });
    this.agentEvents = new AgentEventRenderer({
      transcript: this.transcript,
      tui: this.tui,
      hyperlinks: this.hyperlinks,
      renderLatex: this.renderLatex,
      renderMermaid: this.renderMermaid,
      smoothTextStreaming: options.ui.config?.smoothTextStreaming ?? true,
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    this.externalTools = new ExternalToolsLifecycleController({
      transcript: this.transcript,
      tui: this.tui,
      load: cleanMode ? undefined : this.options.externalTools?.load,
      reload: cleanMode ? undefined : this.options.externalTools?.mcp?.reload,
      isStopping: () => this.stopping,
      onToolsChanged: () => this.recreateAgentForExternalTools(),
      onReady: () => this.conversation.notifyCanStartQueuedRun(),
      updateStatus: (phase) => this.updateStatus(phase, { activeTool: undefined }),
      focusEditor: () => this.bottomArea.showFallback(),
      clearFocus: () => this.bottomArea.clearFocus(),
    });
    this.skillManager = new SkillManagerController({
      editor: this.editor,
      bottomArea: this.bottomArea,
      loadSkills: this.options.skills.load,
      saveEnabledGlobalSkills: this.options.skills.saveEnabledGlobalNames,
      onSkillsChanged: () => this.refreshAgentSystemPrompt(),
      showError: (error) => this.errors.showOverlayError(error),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
    });
    if (!cleanMode && this.options.externalTools?.mcp) {
      const mcp = this.options.externalTools.mcp;
      this.mcpServerManager = new McpServerManagerController({
        editor: this.editor,
        bottomArea: this.bottomArea,
        transcript: this.transcript,
        tui: this.tui,
        loadServers: mcp.loadServers,
        saveEnabledServerIds: mcp.saveEnabledServerIds,
        authorizeServer: mcp.authorizeServer,
        signOutServer: mcp.signOutServer,
        showError: (error) => this.errors.showOverlayError(error),
        onClose: (changed) => {
          if (changed) {
            void this.externalTools.reload();
          } else {
            this.conversation.notifyCanStartQueuedRun();
          }
        },
        updateStatus: (phase, extra) => this.updateStatus(phase, extra),
      });
    }
    this.contentViewer = new ContentViewerController({
      bottomArea: this.bottomArea,
      transcript: this.transcript,
    });
    this.informationViewer = new InformationViewerController({
      editor: this.editor,
      contentViewer: this.contentViewer,
      status: this.status,
      cleanMode,
      hyperlinks: this.hyperlinks,
      renderLatex: this.renderLatex,
      renderMermaid: this.renderMermaid,
      loadMemory: this.options.memory.load,
      loadUsage: this.options.usage.load,
      renderTodos: (width) => renderTodoState(this.conversation.todoState, width),
      showError: (error) => this.showInteractionError(error),
    });
    this.toolHistory = new ToolHistoryController({
      editor: this.editor,
      bottomArea: this.bottomArea,
      transcript: this.transcript,
      contentViewer: this.contentViewer,
    });
    this.scheduledMessageManager = new ScheduledMessageManagerController({
      editor: this.editor,
      bottomArea: this.bottomArea,
      tui: this.tui,
      getQueue: () => this.conversation.inputQueue,
      schedule: (afterMinutes, message) => this.conversation.scheduleInput(afterMinutes, message),
      cancel: (id) => this.conversation.cancelScheduledInput(id),
      showError: (error) => this.showInteractionError(error),
      collapseLongPastes: options.ui.config?.collapseLongPastes ?? true,
      onClose: () => this.conversation.notifyCanStartQueuedRun(),
    });
    this.backgroundJobManager = new BackgroundJobManagerController({
      editor: this.editor,
      bottomArea: this.bottomArea,
      tui: this.tui,
      getJobs: () => {
        const sessionId = this.conversation.sessionId;
        return sessionId ? this.options.conversation.getBackgroundJobs?.(sessionId) : undefined;
      },
      showError: (error) => this.showInteractionError(error),
      onClose: () => this.conversation.notifyCanStartQueuedRun(),
    });
    this.modelSelection = new ModelSelectionController({
      conversation: this.conversation,
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      bottomArea: this.bottomArea,
      status: this.status,
      showError: (error) => this.showError(error),
      getLogger: this.getLogger,
    });
    this.slashCommandOptions = new SlashCommandOptionsController({
      editor: this.editor,
      bottomArea: this.bottomArea,
      onUsageScope: (scope) => this.informationViewer.openUsage(scope),
      onMemoryShow: (scope) => this.informationViewer.openMemory(scope),
      onMemoryCompact: (scope, request) => {
        this.bottomArea.showFallback();
        void this.memoryCompact.compact(scope, request);
      },
      getApprovalMode: () => this.toolApproval.mode,
      onApprovalModeSelect: (mode) => {
        this.bottomArea.showFallback();
        this.setToolApprovalMode(mode);
      },
      collapseLongPastes: options.ui.config?.collapseLongPastes ?? true,
      getModelSettings: this.options.models?.getSettings,
      onModelSelect: (selection) => {
        this.modelSelection.switch(selection);
      },
      showError: (error) => this.showInteractionError(error),
    });
    this.toolApproval = new ToolApprovalController({
      ...options.toolApproval,
      editor: this.editor,
      bottomArea: this.bottomArea,
      tui: this.tui,
      onApprovalRequired: (toolName) => {
        this.updateStatus("tool", {
          activeTool: toolName,
        });
        this.notifications.approvalRequired(toolName);
      },
    });
    this.bottomArea.setFallback(() => this.toolApproval.activePrompt ?? this.editor);
    this.conversation.setBeforeToolExecution(({ toolCall, signal }) =>
      this.showToolApprovalPrompt(toolCall, signal),
    );
    this.localShell = new LocalShellController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      onRunStart: () => this.status.startRun(),
      onRunEnd: () => this.finishAuxiliaryRun(),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
      getLogger: this.getLogger,
    });
    this.memoryCompact = new MemoryCompactController({
      editor: this.editor,
      transcript: this.transcript,
      tui: this.tui,
      compactMemory: this.options.memory.compact,
      onRunStart: () => this.status.startRun(),
      onRunEnd: () => this.finishAuxiliaryRun(),
      updateStatus: (phase, extra) => this.updateStatus(phase, extra),
      getLogger: this.getLogger,
    });
    this.contextCompact = new ContextCompactController({
      transcript: this.transcript,
      tui: this.tui,
      canCompact: () => !this.stopping && !this.externalTools.loading,
      compact: () => this.conversation.compact(),
    });
    this.imageAttachments = new ImageAttachmentController({
      editor: this.editor,
      tui: this.tui,
      getModelMetadata: () => this.conversation.state.model.metadata,
      getModelSettings: this.options.models?.getSettings,
      showError: (error) => this.showInteractionError(error),
      getLogger: this.getLogger,
    });
    this.mcpOAuthStatus = new McpOAuthStatusController({
      transcript: this.transcript,
      tui: this.tui,
    });
    this.sessions = new SessionLifecycleController({
      conversation: this.conversation,
      editor: this.editor,
      bottomArea: this.bottomArea,
      transcript: this.transcript,
      tui: this.tui,
      hyperlinks: this.hyperlinks,
      renderLatex: this.renderLatex,
      renderMermaid: this.renderMermaid,
      isRunning: () => this.status.running,
      closeOtherOverlays: () => {
        this.skillManager.close();
        this.scheduledMessageManager.close();
        this.backgroundJobManager.close();
        this.toolHistory.close();
      },
      closeContentViewer: () => this.contentViewer.close(),
      resetAgentEvents: () => this.agentEvents.resetRun(),
      clearMcpOAuthBlocks: () => this.mcpOAuthStatus.clear(),
      updateContextUsage: () => this.updateContextUsage(),
      updateStatus: (phase) => this.updateStatus(phase, { activeTool: undefined }),
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
      isRunning: () => this.status.running,
      stop: () => {
        void this.stop();
      },
      submitRaw: (raw) => {
        void this.submitPrompt(raw);
      },
      showError: (error) => this.showInteractionError(error),
      showHelp: () => this.informationViewer.openHelp(),
      clear: () => {
        this.contentViewer.close();
        this.transcript.clear();
        this.mcpOAuthStatus.clear();
        this.editor.clear();
        this.tui.requestRender();
      },
      startNewSession: () => {
        this.editor.clear();
        void this.sessions.startNew();
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
        void this.sessions.resume(sessionId);
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
      openBackgroundJobManager: () => {
        this.editor.clear();
        this.openBackgroundJobManager();
      },
      startGoal: (objective) => {
        this.editor.clear();
        void this.startGoal(objective);
      },
      openTodo: () => {
        this.editor.clear();
        this.openTodoViewer();
      },
      openToolHistory: () => {
        this.editor.clear();
        this.openToolHistoryPicker();
      },
      attachImageFile: (path) => {
        void this.imageAttachments.attachFile(path);
      },
      openApproval: () => this.slashCommandOptions.openApproval(),
      openModel: () => this.slashCommandOptions.openModel(),
      openMemory: () => this.openMemory(),
      compactContext: () => {
        this.editor.clear();
        void this.contextCompact.compact();
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
      launchMode: this.options.launch.mode ?? "normal",
      resumed: this.conversation.sessionId !== undefined,
    });
    void preloadSyntaxHighlighter().then(
      () => this.tui.requestRender(),
      () => undefined,
    );

    if (!this.options.launch.startInResumePicker) {
      this.sessions.initializeTranscript(this.options.conversation.initialSession?.timeline ?? []);
    }
    if (this.options.launch.mode === "clean") {
      this.transcript.addChild(
        new TextBlock("Clean mode · temporary session; customizations and saving are disabled.", {
          color: tuiTheme.muted,
        }),
      );
    }

    this.tui.addChild(this.layout);
    this.bottomArea.show(this.editor);
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
      void this.imageAttachments.pasteClipboard();
    };
    this.editor.onEscape = () => {
      if (this.status.running) {
        this.abort();
      }
    };

    this.updateStatus("idle");
    this.tui.start();

    if (this.options.launch.startInResumePicker) {
      this.sessions.openResume();
      return;
    }

    void this.activateCurrentSession(this.options.launch.initialPrompt);
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
      this.options.lifecycle?.forceStop === undefined
        ? status
        : `${status}\nPress Ctrl+C again to force quit.`,
    );
    if (!this.transcript.children.includes(this.shutdownStatus)) {
      this.transcript.addChild(this.shutdownStatus);
    }
    this.bottomArea.clearFocus();
    this.tui.requestRender();
  }

  showMcpOAuthAuthorization(serverId: string, authorizationUrl: string): void {
    this.mcpOAuthStatus.showAuthorization(serverId, authorizationUrl);
  }

  handleMcpOAuthDiagnostic(serverId: string, diagnostic: McpOAuthHttpDiagnosticEvent): void {
    this.mcpOAuthStatus.handleDiagnostic(serverId, diagnostic);
  }

  private async stopInternal(): Promise<void> {
    this.getLogger().info("tui.stopped");
    this.localShell.abort();
    this.memoryCompact.abort();
    this.scheduledMessageManager.close();
    this.backgroundJobManager.close();
    this.mcpServerManager?.close();
    this.unsubscribeConversationEvents();
    this.showShutdownStatus("Shutting down Kana...");
    const resumeSessionId = this.options.conversation.getResumeSessionId();
    const totalUsage = this.status.formatTotalUsage();
    const exitLines = [
      totalUsage ? formatExitLine("Token usage", totalUsage) : undefined,
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
      await this.options.lifecycle?.stop?.();
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
        this.options.lifecycle?.forceStop?.();
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
      // A successful toggle replaces the bottom view, so an open picker must relinquish
      // ownership. If no tool opens, the failed toggle leaves the picker active.
      if (this.contentViewer.toggleLatest()) {
        this.toolHistory.relinquish();
        this.backgroundJobManager.close();
        return { consume: true };
      }

      return undefined;
    }

    if (isCtrlC(data)) {
      if (this.status.running) {
        this.abort();
        return { consume: true };
      }

      if (
        this.bottomArea.isShowing(this.editor) &&
        this.bottomArea.hasFocus(this.editor) &&
        this.editor.hasDraft()
      ) {
        this.editor.clear();
        return { consume: true };
      }

      void this.stop();
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

  private async forkSession(prompt: string): Promise<void> {
    await this.sessions.fork(prompt);
  }

  private refreshAgentSystemPrompt(): void {
    this.conversation.reconfigure();
  }

  private openSkillManager(): void {
    if (this.options.launch.mode === "clean") {
      this.showError(new Error("Skills are unavailable in clean mode."));
      return;
    }
    if (this.status.running) {
      return;
    }

    this.sessions.close();
    this.contentViewer.close();
    this.scheduledMessageManager.close();
    this.backgroundJobManager.close();
    this.toolHistory.close();
    this.skillManager.open();
  }

  private openMcpServerManager(): void {
    if (this.options.launch.mode === "clean") {
      this.showError(new Error("MCP management is unavailable in clean mode."));
      return;
    }
    if (this.status.running) {
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
    this.backgroundJobManager.close();
    this.toolHistory.close();
    this.mcpServerManager.open();
  }

  private openScheduledMessageManager(): void {
    this.sessions.close();
    this.contentViewer.close();
    this.skillManager.close();
    this.mcpServerManager?.close();
    this.backgroundJobManager.close();
    this.toolHistory.close();
    this.scheduledMessageManager.open();
  }

  private openBackgroundJobManager(): void {
    this.sessions.close();
    this.contentViewer.close();
    this.skillManager.close();
    this.mcpServerManager?.close();
    this.scheduledMessageManager.close();
    this.backgroundJobManager.close();
    this.toolHistory.close();
    this.backgroundJobManager.open();
  }

  private openToolHistoryPicker(): void {
    this.sessions.close();
    this.contentViewer.close();
    this.skillManager.close();
    this.mcpServerManager?.close();
    this.scheduledMessageManager.close();
    this.backgroundJobManager.close();
    this.toolHistory.open();
  }

  private openTodoViewer(): void {
    this.sessions.close();
    this.skillManager.close();
    this.mcpServerManager?.close();
    this.scheduledMessageManager.close();
    this.backgroundJobManager.close();
    this.toolHistory.close();
    this.informationViewer.openTodos();
  }

  private openMemory(): void {
    if (this.options.launch.mode === "clean") {
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
        this.status.startRun();
        this.agentEvents.resetRun();
        if (event.source === "user" && event.input) {
          this.transcript.addChild(new UserMessageBlock(event.input));
        } else if (event.source === "goal" && event.input) {
          this.transcript.addChild(
            event.input.provenance.kind === "goal_continuation"
              ? new TextBlock(`Goal continuation · round ${event.input.provenance.round}`, {
                  color: tuiTheme.muted,
                })
              : new UserMessageBlock(event.input),
          );
        } else if (event.source === "scheduled" && event.input) {
          this.transcript.addChild(
            new TextBlock(`Scheduled wake: ${formatScheduledWakeContent(event.input.content)}`, {
              color: tuiTheme.muted,
            }),
          );
        } else if (event.source === "job" && event.input) {
          this.transcript.addChild(
            new TextBlock(formatBackgroundJobWakeContent(event.input.content), {
              color: tuiTheme.muted,
            }),
          );
        }
        this.updateStatus(event.source === "compaction" ? "compacting" : "starting");
        this.tui.requestRender();
        break;

      case "agent_event":
        if (event.event.type === "context_compacted") {
          this.contextCompact.handleCompacted();
        }
        if (event.event.type === "turn_input") {
          this.queuedInputs.deliverTurn(event.event.message);
        }
        this.agentEvents.handle(event.event);
        if (event.source !== "compaction" && event.source !== "goal") {
          this.notifications.handleAgentEvent(event.event);
        }
        if (event.event.type === "message_end") {
          this.status.recordUsage(event.event.message.usage);
        } else if (event.event.type === "turn_end") {
          this.updateContextUsage(event.event.estimatedContextTokens);
          this.tui.requestRender();
        } else if (event.event.type === "context_compacted") {
          this.status.recordUsage(event.event.usage);
        }
        break;

      case "run_end":
        if (event.source === "goal" && event.goal?.status === "completed") {
          this.notifications.agentCompleted();
        }
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

      case "todo_state_changed":
        this.agentEvents.handleTodoStateChange(event.change);
        break;

      case "goal_state_changed":
        if (event.change === "round_limit") {
          this.transcript.addChild(
            new TextBlock(`Goal stopped · reached the ${event.goal.maxRounds}-round limit.`, {
              color: tuiTheme.muted,
            }),
          );
          this.tui.requestRender();
        }
        break;
    }
  }

  private finishConversationRun(): void {
    this.status.finishRun(true);
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
    this.errors.showRunError(error);
  }

  private showInteractionError(error: unknown): void {
    this.errors.showInteractionError(error);
  }

  private async submitPrompt(value: string, images: UserImage[] = []): Promise<void> {
    const prompt = value.trim();

    if (!prompt && images.length === 0) {
      return;
    }
    const imageInputError = this.imageAttachments.getInputError(images);
    if (imageInputError) {
      this.showInteractionError(imageInputError);
      return;
    }
    const input = createUserMessage({
      content: prompt,
      provenance: { kind: "user_input" },
      ...(images.length > 0 ? { images: structuredClone(images) } : {}),
    });

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
    if (this.status.running) {
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
    const imageInputError = this.imageAttachments.getInputError(images);
    if (imageInputError) {
      this.showInteractionError(imageInputError);
      return;
    }
    const input = createUserMessage({
      content: prompt,
      provenance: { kind: "user_input" },
      ...(images.length > 0 ? { images: structuredClone(images) } : {}),
    });

    this.editor.addToHistory(prompt);
    this.editor.clear();
    this.conversation.queueInput(input);
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

  private async startGoal(objective: string): Promise<void> {
    if (this.stopping || this.externalTools.loading) {
      return;
    }

    const previousGoalId = this.conversation.goal?.id;
    try {
      await this.conversation.startGoal(objective);
    } catch (error) {
      if (this.conversation.goal?.id === previousGoalId) {
        this.showError(error);
      }
    }
  }

  private async submitShellCommand(command: string): Promise<void> {
    const shellCommand = command.trim();

    if (!shellCommand || this.status.running || this.externalTools.loading) {
      return;
    }

    await this.localShell.submit(shellCommand);
  }

  private finishAuxiliaryRun(): void {
    this.status.finishRun();
    this.conversation.notifyCanStartQueuedRun();
  }

  private showToolApprovalPrompt(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    this.agentEvents.prepareForToolInteraction();
    return this.toolApproval.request(toolCall, signal);
  }

  private updateStatus(...args: Parameters<StatusProjectionController["update"]>): void {
    this.status.update(...args);
  }

  private updateContextUsage(estimatedTokens?: number): void {
    this.status.updateContextUsage(estimatedTokens);
  }
}

function formatScheduledWakeContent(content: string): string {
  return content.replace(/^\[Scheduled wake event\]\n/, "");
}

function formatBackgroundJobWakeContent(content: string): string {
  return content.replace(/^\[Background Job completion\]\n?/, "");
}

function formatExitLine(label: string, value: string): string {
  return `${`${label}:`.padEnd(13)}${value}`;
}
