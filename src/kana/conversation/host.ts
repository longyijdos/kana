import type { Agent, ContextCheckpoint } from "@/agent";
import { addModelUsage, type Message, type ModelUsage } from "@/core";
import { createNoopLogger, createSessionLogManager, type Logger } from "@/logging";
import type { McpOAuthHttpDiagnosticEvent, McpToolSource } from "@/mcp";
import type { Tool } from "@/tools";
import {
  type KanaUsageScope,
  type KanaUsageSummary,
  loadKanaUsageSummary,
  recordKanaAgentRunAccounting,
} from "../accounting";
import { createKanaAgent, KANA_BUILT_IN_TOOL_NAMES, type KanaAgentOptions } from "../agent";
import { createKanaOAuthTokenStore, type KanaOAuthTokenStatus } from "../auth";
import {
  getActiveKanaModelConfig,
  type KanaConfig,
  type KanaNotificationConfig,
  type KanaToolApprovalConfig,
  type KanaTuiConfig,
} from "../config";
import { createKanaConfigStore, type KanaConfigStore } from "../config-store";
import type { KanaLaunchMode } from "../launch-mode";
import {
  authorizeKanaMcpServer,
  createKanaMcpRuntime,
  type KanaMcpRuntime,
  type KanaMcpRuntimeProgressEvent,
  type KanaMcpRuntimeSnapshot,
  type KanaMcpServerActivation,
  loadKanaMcpServerActivations,
  saveKanaMcpActivationState,
  signOutKanaMcpServer,
} from "../mcp";
import {
  createMemoryConsolidationQueue,
  createMemoryConsolidationScheduler,
  loadKanaMemory,
  type MemoryConsolidationQueue,
  type MemoryConsolidationScheduler,
  runFullMemoryConsolidation,
} from "../memory";
import { getKanaSessionLogPath } from "../path";
import {
  createKanaSession,
  createKanaSessionJournal,
  deleteKanaSession,
  type KanaSessionJournal,
  type KanaSessionMetadata,
  type LoadKanaSessionResult,
  listKanaSessions,
  loadKanaSession,
} from "../session";
import { type KanaToolApprovals, loadKanaToolApprovals } from "../tool-approval";
import { createWakeScheduler, type WakeScheduler } from "./wake-scheduler";

export type KanaConversationHostSession =
  | { type: "new" }
  | { type: "resume"; sessionId: string }
  | { type: "none" };

export type KanaConversationHostAgentOptions<TConfiguration> = Pick<
  KanaAgentOptions,
  "beforeToolExecution" | "messages" | "contextCheckpoint"
> & {
  sessionId?: string;
  configuration?: TConfiguration;
};

export type KanaMemoryCompactSummary = {
  target: "global" | "project";
  outcome: "updated" | "unchanged" | "aborted" | "length" | "turn_limit" | "error";
  error?: string;
};

export type CreateKanaConversationHostOptions<TConfiguration = never> = {
  session?: KanaConversationHostSession;
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
  enableScheduledWakeTool?: boolean;
  applyAgentConfiguration?: (config: KanaConfig, configuration: TConfiguration) => void;
  onMcpProgress?: (event: KanaMcpRuntimeProgressEvent) => void;
  openMcpOAuthAuthorizationUrl?: (serverId: string, url: string) => Promise<void>;
  onMcpOAuthDiagnostic?: (serverId: string, event: McpOAuthHttpDiagnosticEvent) => void;
  createAgent?: typeof createKanaAgent;
  createConfigStore?: (env: NodeJS.ProcessEnv) => KanaConfigStore;
  createMcpRuntime?: typeof createKanaMcpRuntime;
};

type HostedSession = {
  data: LoadKanaSessionResult;
  journal: KanaSessionJournal;
  logger: Logger;
  pendingForkMessages?: Message[];
  pendingForkCheckpoint?: ContextCheckpoint;
};

export class KanaConversationHost<TConfiguration = never> {
  readonly initialSession?: LoadKanaSessionResult;
  readonly launchMode: KanaLaunchMode;
  readonly wakeScheduler: WakeScheduler;
  readonly toolApprovals: KanaToolApprovals;

  private readonly env: NodeJS.ProcessEnv;
  private readonly configStore: KanaConfigStore;
  private readonly createAgentProduct: typeof createKanaAgent;
  private readonly enableScheduledWakeTool: boolean;
  private readonly applyAgentConfiguration?: (
    config: KanaConfig,
    configuration: TConfiguration,
  ) => void;
  private readonly logManager;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly memoryConsolidationQueue: MemoryConsolidationQueue;
  private readonly oauthTokenStore;
  private readonly mcpRuntime: KanaMcpRuntime;
  private configData: KanaConfig;
  private memoryConsolidation?: MemoryConsolidationScheduler;
  private mcpTools: Tool[] = [];
  private activeSessionId?: string;
  private resumableSessionId?: string;

  constructor(options: CreateKanaConversationHostOptions<TConfiguration> = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.launchMode = options.launchMode ?? "normal";
    this.configStore = (options.createConfigStore ?? createKanaConfigStore)(this.env);
    this.configData = this.configStore.load();
    this.createAgentProduct = options.createAgent ?? createKanaAgent;
    this.enableScheduledWakeTool = options.enableScheduledWakeTool ?? true;
    this.applyAgentConfiguration = options.applyAgentConfiguration;
    this.logManager = createSessionLogManager({ level: this.configData.logging.level });
    this.toolApprovals = loadKanaToolApprovals(this.env);
    this.memoryConsolidationQueue = createMemoryConsolidationQueue();
    this.memoryConsolidation = this.createMemoryConsolidation(this.configData);
    this.wakeScheduler = createWakeScheduler();

    const initialSession = this.loadInitialSession(options.session ?? { type: "new" });
    this.initialSession = initialSession?.data;

    this.oauthTokenStore = createKanaOAuthTokenStore({
      env: this.env,
      getLogger: () => this.getLogger(),
    });
    this.mcpRuntime = (options.createMcpRuntime ?? createKanaMcpRuntime)({
      env: this.env,
      reservedToolNames: KANA_BUILT_IN_TOOL_NAMES,
      getLogger: () => this.getLogger(),
      oauthTokenStore: this.oauthTokenStore,
      openOAuthAuthorizationUrl: async (serverId, url) => {
        if (!options.openMcpOAuthAuthorizationUrl) {
          throw new Error(`MCP server ${serverId} requires interactive OAuth authorization.`);
        }
        await options.openMcpOAuthAuthorizationUrl(serverId, url);
      },
      onOAuthDiagnostic: options.onMcpOAuthDiagnostic,
      onProgress: options.onMcpProgress,
    });
  }

  get config(): KanaConfig {
    return structuredClone(this.configData);
  }

  get approvalConfig(): KanaToolApprovalConfig {
    return structuredClone(this.configData.approval);
  }

  get notificationConfig(): KanaNotificationConfig {
    return structuredClone(this.configData.notification);
  }

  get tuiConfig(): KanaTuiConfig {
    return structuredClone(this.configData.tui);
  }

  get resumeSessionId(): string | undefined {
    return this.resumableSessionId;
  }

  getLogger(): Logger {
    return this.activeSessionId === undefined
      ? createNoopLogger()
      : (this.sessions.get(this.activeSessionId)?.logger ?? createNoopLogger());
  }

  createAgent(options: KanaConversationHostAgentOptions<TConfiguration>) {
    const hostedSession =
      options.sessionId === undefined ? undefined : this.sessions.get(options.sessionId);
    if (options.sessionId !== undefined && !hostedSession) {
      throw new Error(`Kana conversation host has no session ${options.sessionId}.`);
    }
    const agentLogger = hostedSession?.logger ?? createNoopLogger();
    const { configuration, ...agentOptions } = options;
    const kanaAgentOptions = this.createKanaAgentOptions(agentOptions, hostedSession, agentLogger);

    let agent: Agent;
    if (configuration === undefined) {
      agent = this.createAgentProduct(this.configData, kanaAgentOptions);
    } else {
      if (!this.applyAgentConfiguration) {
        throw new Error("This Kana conversation host does not support Agent reconfiguration.");
      }
      let nextAgent: Agent | undefined;
      let nextMemoryConsolidation = this.memoryConsolidation;
      const nextConfig = this.configStore.update((draft) => {
        this.applyAgentConfiguration?.(draft, configuration);
        nextAgent = this.createAgentProduct(draft, kanaAgentOptions);
        nextMemoryConsolidation = this.createMemoryConsolidation(draft);
      });
      if (!nextAgent) {
        throw new Error("Kana could not initialize the selected model.");
      }
      this.configData = nextConfig;
      this.memoryConsolidation = nextMemoryConsolidation;
      agent = nextAgent;
    }

    // Session callbacks register candidates before ConversationRuntime builds
    // their Agent. Adopt the candidate only after every constructor succeeds.
    this.activeSessionId = options.sessionId;
    return agent;
  }

  createNewSession(): { id: string } {
    const hosted = this.registerSession({
      metadata: this.createSessionMetadata(),
      messages: [],
      timeline: [],
    });
    hosted.logger.info("session.created");
    return { id: hosted.data.metadata.id };
  }

  forkSession(
    messages: Message[],
    contextCheckpoint: ContextCheckpoint | undefined,
    prompt: string,
  ): { id: string } {
    let source =
      this.activeSessionId === undefined ? undefined : this.sessions.get(this.activeSessionId);
    if (!source) {
      source = this.registerSession({
        metadata: this.createSessionMetadata(),
        messages: [],
        timeline: [],
      });
    }
    const hosted = this.registerSession({
      metadata: this.createSessionMetadata(source.data.metadata.path, prompt),
      messages: structuredClone(messages),
      timeline: [],
      contextCheckpoint: structuredClone(contextCheckpoint),
    });
    hosted.pendingForkMessages = structuredClone(messages);
    hosted.pendingForkCheckpoint =
      contextCheckpoint === undefined
        ? undefined
        : {
            ...structuredClone(contextCheckpoint),
            baseCompactionId: undefined,
          };
    hosted.logger.info("session.forked", {
      sourceSessionId: source.data.metadata.id,
    });
    return { id: hosted.data.metadata.id };
  }

  loadSession(sessionId: string): LoadKanaSessionResult {
    const hosted = this.registerSession(
      loadKanaSession(sessionId, { cwd: process.cwd(), env: this.env }),
    );
    this.logLoadedSession(hosted, "session.resumed");
    return structuredClone(hosted.data);
  }

  listSessions(): KanaSessionMetadata[] {
    return listKanaSessions({ cwd: process.cwd(), env: this.env });
  }

  deleteSession(sessionId: string): boolean {
    const deleted = deleteKanaSession(sessionId, {
      cwd: process.cwd(),
      env: this.env,
    });
    if (deleted) {
      this.sessions.delete(sessionId);
    }
    return deleted;
  }

  async startMcp(): Promise<KanaMcpRuntimeSnapshot> {
    return this.runMcpOperation("start");
  }

  async reloadMcp(): Promise<KanaMcpRuntimeSnapshot> {
    return this.runMcpOperation("reload");
  }

  closeMcp(): Promise<void> {
    return this.mcpRuntime.close();
  }

  getMcpToolSource(toolName: string): McpToolSource | undefined {
    return this.mcpRuntime.getToolSource(toolName);
  }

  loadMcpServers(): KanaMcpServerActivation[] {
    if (this.launchMode === "clean") {
      return [];
    }

    return loadKanaMcpServerActivations(this.env);
  }

  saveEnabledMcpServerIds(serverIds: string[]): void {
    this.assertCustomizationsAvailable("MCP management");
    saveKanaMcpActivationState({ enabledServers: serverIds }, this.env);
  }

  authorizeMcpServer(
    serverId: string,
    openAuthorizationUrl: (url: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<KanaOAuthTokenStatus> {
    this.assertCustomizationsAvailable("MCP authorization");
    return authorizeKanaMcpServer(serverId, {
      env: this.env,
      getLogger: () => this.getLogger(),
      tokenStore: this.oauthTokenStore,
      signal,
      openAuthorizationUrl,
    });
  }

  signOutMcpServer(serverId: string): Promise<KanaOAuthTokenStatus> {
    this.assertCustomizationsAvailable("MCP authorization");
    return signOutKanaMcpServer(serverId, {
      env: this.env,
      getLogger: () => this.getLogger(),
      tokenStore: this.oauthTokenStore,
    });
  }

  async compactMemory(
    target: "global" | "project" | "both",
    userRequest: string | undefined,
    signal: AbortSignal,
  ): Promise<KanaMemoryCompactSummary[]> {
    this.assertCustomizationsAvailable("Memory");
    const logger = this.getLogger();
    const scopes: Array<"global" | "project"> =
      target === "both" ? ["global", "project"] : [target];

    return Promise.all(
      scopes.map(async (scope): Promise<KanaMemoryCompactSummary> => {
        try {
          const result = await this.memoryConsolidationQueue.enqueue(scope, () =>
            runFullMemoryConsolidation(this.configData, {
              scope,
              cwd: process.cwd(),
              env: this.env,
              userRequest,
              signal,
              logger,
            }),
          );
          const activeSession = this.getActiveHostedSession();
          if (activeSession) {
            recordKanaAgentRunAccounting({
              sessionId: activeSession.data.metadata.id,
              cwd: activeSession.data.metadata.cwd,
              agentKind: "memory_consolidation",
              outcome: result.outcome,
              messages: result.state.messages,
              model: result.state.model.metadata,
              memory: { scope, mode: "full", origin: "manual" },
            });
          }
          return { target: scope, outcome: result.outcome };
        } catch (error) {
          return {
            target: scope,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  loadMemory(target: "global" | "project"): string {
    this.assertCustomizationsAvailable("Memory");
    return loadKanaMemory(target, { cwd: process.cwd(), env: this.env });
  }

  loadUsage(scope: KanaUsageScope): KanaUsageSummary {
    return loadKanaUsageSummary({
      scope,
      sessionId: scope === "session" ? this.activeSessionId : undefined,
      cwd: process.cwd(),
      env: this.env,
    });
  }

  private createKanaAgentOptions(
    options: Pick<
      KanaConversationHostAgentOptions<TConfiguration>,
      "beforeToolExecution" | "messages" | "contextCheckpoint" | "sessionId"
    >,
    hostedSession: HostedSession | undefined,
    agentLogger: Logger,
  ): KanaAgentOptions {
    const appendTimeline = (entries: LoadKanaSessionResult["timeline"]): void => {
      if (!hostedSession) {
        throw new Error("Cannot update a session journal without an active session.");
      }
      hostedSession.data.timeline = [...hostedSession.data.timeline, ...entries];
    };
    const writeJournal = <T>(
      phase: "start" | "message" | "compaction" | "end" | "snapshot",
      operation: () => T,
    ): T => {
      try {
        return operation();
      } catch (error) {
        agentLogger.error("session.journal_write_failed", { phase, error });
        throw error;
      }
    };

    return {
      ...options,
      additionalTools: this.mcpTools,
      env: this.env,
      launchMode: this.launchMode,
      logger: agentLogger,
      wakeScheduler: this.enableScheduledWakeTool ? this.wakeScheduler : undefined,
      messages: options.messages ?? hostedSession?.data.messages,
      contextCheckpoint: options.contextCheckpoint ?? hostedSession?.data.contextCheckpoint,
      journal:
        hostedSession === undefined
          ? undefined
          : {
              startRun: ({ runId, messages }) => {
                if (hostedSession.pendingForkMessages) {
                  const snapshotEntries = writeJournal("snapshot", () =>
                    hostedSession.journal.appendSnapshot(hostedSession.pendingForkMessages ?? [], {
                      compactions: hostedSession.pendingForkCheckpoint
                        ? [hostedSession.pendingForkCheckpoint]
                        : [],
                    }),
                  );
                  appendTimeline(snapshotEntries);
                  hostedSession.pendingForkMessages = undefined;
                  hostedSession.pendingForkCheckpoint = undefined;
                }

                const entries = writeJournal("start", () =>
                  hostedSession.journal.startTurn(runId, messages),
                );
                appendTimeline(entries);
                hostedSession.data.messages = [
                  ...hostedSession.data.messages,
                  ...structuredClone(messages),
                ];
                this.resumableSessionId = hostedSession.data.metadata.id;
              },
              appendMessage: ({ runId, message }) => {
                const entry = writeJournal("message", () =>
                  hostedSession.journal.appendMessage(runId, message),
                );
                appendTimeline([entry]);
                hostedSession.data.messages = [
                  ...hostedSession.data.messages,
                  structuredClone(message),
                ];
              },
              appendCompaction: ({ runId, compaction }) => {
                const entry = writeJournal("compaction", () =>
                  hostedSession.journal.appendCompaction(compaction, {
                    turnId: runId,
                  }),
                );
                appendTimeline([entry]);
                hostedSession.data.contextCheckpoint = structuredClone(compaction);
              },
              endRun: ({ runId, reason }) => {
                const entry = writeJournal("end", () =>
                  hostedSession.journal.endTurn(runId, reason),
                );
                appendTimeline([entry]);
              },
            },
      onRunCommitted: ({ messages, compactions, state, event }) => {
        if (!hostedSession) {
          throw new Error("Cannot complete an Agent run without an active session.");
        }

        try {
          recordKanaAgentRunAccounting({
            sessionId: hostedSession.data.metadata.id,
            cwd: hostedSession.data.metadata.cwd,
            agentKind: "main",
            outcome: event.reason,
            messages,
            model: state.model.metadata,
            additionalUsage: addCompactionUsage(compactions),
          });
        } catch (error) {
          agentLogger.error("accounting.record_failed", {
            phase: "conversation_run",
            error,
          });
        }

        const accountingSession = {
          id: hostedSession.data.metadata.id,
          cwd: hostedSession.data.metadata.cwd,
        };
        void this.memoryConsolidation
          ?.schedule(messages, {
            logger: agentLogger,
            onCompleted: (scope, result) =>
              recordKanaAgentRunAccounting({
                sessionId: accountingSession.id,
                cwd: accountingSession.cwd,
                agentKind: "memory_consolidation",
                outcome: result.outcome,
                messages: result.state.messages,
                model: result.state.model.metadata,
                memory: { scope, mode: "incremental", origin: "automatic" },
              }),
          })
          .catch((error) => {
            agentLogger.error("memory_consolidation.failed", { error });
          });
      },
      onCompactionCommitted: ({ compaction, state }) => {
        if (!hostedSession) {
          throw new Error("Cannot persist context compaction without an active session.");
        }

        try {
          recordKanaAgentRunAccounting({
            sessionId: hostedSession.data.metadata.id,
            cwd: hostedSession.data.metadata.cwd,
            agentKind: "main",
            outcome: "stop",
            messages: [],
            model: state.model.metadata,
            additionalUsage: compaction.usage,
          });
        } catch (error) {
          agentLogger.error("accounting.record_failed", {
            phase: "manual_compaction",
            error,
          });
        }
      },
    };
  }

  private loadInitialSession(session: KanaConversationHostSession): HostedSession | undefined {
    if (session.type === "none") {
      return undefined;
    }
    if (session.type === "resume") {
      const hosted = this.registerSession(
        loadKanaSession(session.sessionId, {
          cwd: process.cwd(),
          env: this.env,
        }),
      );
      this.resumableSessionId = hosted.data.metadata.id;
      this.logLoadedSession(hosted, "session.started", { resumed: true });
      return hosted;
    }

    const hosted = this.registerSession({
      metadata: this.createSessionMetadata(),
      messages: [],
      timeline: [],
    });
    hosted.logger.info("session.started", {
      resumed: false,
      launchMode: this.launchMode,
    });
    return hosted;
  }

  private registerSession(data: LoadKanaSessionResult): HostedSession {
    const hosted: HostedSession = {
      data: structuredClone(data),
      journal: createKanaSessionJournal(data.metadata, data.timeline),
      logger: this.logManager.forSession({
        path: getKanaSessionLogPath(data.metadata.id, {
          cwd: data.metadata.cwd,
          env: this.env,
        }),
        sessionId: data.metadata.id,
      }),
    };
    this.sessions.set(hosted.data.metadata.id, hosted);
    return hosted;
  }

  private logLoadedSession(
    hosted: HostedSession,
    event: string,
    metadata?: Record<string, unknown>,
  ): void {
    hosted.logger.info(event, {
      ...metadata,
      launchMode: this.launchMode,
    });
    if (hosted.data.recoveredInterruptedTurn) {
      hosted.logger.warn("session.interrupted_turn_recovered", {
        unknownToolCallCount: hosted.data.recoveredInterruptedTurn.unknownToolCallCount,
      });
    }
    if (hosted.data.recoveredIncompleteTail) {
      hosted.logger.warn("session.incomplete_tail_recovered");
    }
  }

  private createSessionMetadata(parentSessionPath?: string, title?: string): KanaSessionMetadata {
    const modelConfig = getActiveKanaModelConfig(this.configData);
    return createKanaSession({
      env: this.env,
      title,
      model: {
        provider: this.configData.provider.active,
        model: modelConfig.name,
      },
      parentSessionPath,
    });
  }

  private createMemoryConsolidation(config: KanaConfig): MemoryConsolidationScheduler | undefined {
    return this.launchMode !== "clean" && config.memory.enabled
      ? createMemoryConsolidationScheduler(config, {
          env: this.env,
          queue: this.memoryConsolidationQueue,
        })
      : undefined;
  }

  private async runMcpOperation(operation: "start" | "reload"): Promise<KanaMcpRuntimeSnapshot> {
    if (this.launchMode === "clean") {
      this.mcpTools = [];
      this.getLogger().info("mcp.skipped", {
        operation,
        reason: "clean_mode",
      });
      return {
        tools: [],
        diagnostics: [],
        selectedServerIds: [],
      };
    }

    try {
      const snapshot = await (operation === "start"
        ? this.mcpRuntime.start()
        : this.mcpRuntime.reload());
      this.mcpTools = snapshot.tools;
      this.getLogger().info(operation === "start" ? "mcp.started" : "mcp.reloaded", {
        configuredServerCount: snapshot.selectedServerIds.length,
        readyServerCount: snapshot.diagnostics.filter((diagnostic) => diagnostic.status === "ready")
          .length,
        toolCount: this.mcpTools.length,
      });
      return snapshot;
    } catch (error) {
      this.mcpTools = this.mcpRuntime.tools;
      throw error;
    }
  }

  private getActiveHostedSession(): HostedSession | undefined {
    return this.activeSessionId === undefined ? undefined : this.sessions.get(this.activeSessionId);
  }

  private assertCustomizationsAvailable(feature: string): void {
    if (this.launchMode === "clean") {
      throw new Error(`${feature} is unavailable in clean mode.`);
    }
  }
}

export function createKanaConversationHost<TConfiguration = never>(
  options: CreateKanaConversationHostOptions<TConfiguration> = {},
): KanaConversationHost<TConfiguration> {
  return new KanaConversationHost(options);
}

function addCompactionUsage(compactions: ContextCheckpoint[]): ModelUsage | undefined {
  return compactions.reduce<ModelUsage | undefined>(
    (total, compaction) => (compaction.usage ? addModelUsage(total, compaction.usage) : total),
    undefined,
  );
}
