import type { Agent, ContextCheckpoint } from "@/agent";
import { addModelUsage, type Message, type ModelUsage } from "@/core";
import type { BackgroundJobClient } from "@/jobs";
import type { Logger } from "@/logging";
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
  createKanaConfigStore,
  type KanaConfig,
  type KanaConfigStore,
  type KanaNotificationConfig,
  type KanaToolApprovalConfig,
  type KanaTuiConfig,
  validateKanaConfig,
} from "../config";
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
import type { KanaSessionMetadata, LoadKanaSessionResult } from "../session";
import type { KanaTodoItem, KanaTodoStateChange } from "../todo";
import { type KanaToolApprovals, loadKanaToolApprovals } from "../tool-approval";
import type { KanaGoalSnapshot, KanaGoalUpdate } from "./goal-controller";
import { type HostedSessionAgentBinding, HostedSessionRegistry } from "./hosted-session-registry";
import { createWakeScheduler, type WakeScheduler } from "./wake-scheduler";

export type KanaConversationHostSession =
  | { type: "new" }
  | { type: "resume"; sessionId: string }
  | { type: "none" };

export type KanaConversationHostAgentOptions<TConfiguration> = Pick<
  KanaAgentOptions,
  "beforeToolExecution" | "inbox" | "messages" | "contextCheckpoint"
> & {
  sessionId?: string;
  configuration?: TConfiguration;
  onTodoStateCommitted?: (change: KanaTodoStateChange) => void;
  resolveGoal?: () => KanaGoalSnapshot | undefined;
  updateGoal?: (change: KanaGoalUpdate) => KanaGoalSnapshot;
};

export type KanaMemoryCompactSummary = {
  target: "global" | "project";
  outcome: "updated" | "unchanged" | "aborted" | "length" | "turn_limit" | "error";
  error?: string;
};

type KanaAgentProductFactory = (config: KanaConfig, options?: KanaAgentOptions) => Agent;

export type CreateKanaConversationHostOptions<TConfiguration = never> = {
  session?: KanaConversationHostSession;
  env?: NodeJS.ProcessEnv;
  launchMode?: KanaLaunchMode;
  enableScheduledWakeTool?: boolean;
  applyAgentConfiguration?: (config: KanaConfig, configuration: TConfiguration) => void;
  onMcpProgress?: (event: KanaMcpRuntimeProgressEvent) => void;
  openMcpOAuthAuthorizationUrl?: (serverId: string, url: string) => Promise<void>;
  onMcpOAuthDiagnostic?: (serverId: string, event: McpOAuthHttpDiagnosticEvent) => void;
  createAgent?: KanaAgentProductFactory;
  createConfigStore?: (env: NodeJS.ProcessEnv) => KanaConfigStore;
  createMcpRuntime?: typeof createKanaMcpRuntime;
};

export class KanaConversationHost<TConfiguration = never> {
  readonly initialSession?: LoadKanaSessionResult;
  readonly launchMode: KanaLaunchMode;
  readonly wakeScheduler: WakeScheduler;
  readonly toolApprovals: KanaToolApprovals;

  private readonly env: NodeJS.ProcessEnv;
  private readonly configStore: KanaConfigStore;
  private readonly createAgentProduct: KanaAgentProductFactory;
  private readonly enableScheduledWakeTool: boolean;
  private readonly applyAgentConfiguration?: (
    config: KanaConfig,
    configuration: TConfiguration,
  ) => void;
  private readonly sessionRegistry: HostedSessionRegistry;
  private readonly memoryConsolidationQueue: MemoryConsolidationQueue;
  private readonly memoryConsolidationSchedulers = new Set<MemoryConsolidationScheduler>();
  private readonly oauthTokenStore;
  private readonly mcpRuntime: KanaMcpRuntime;
  private configData: KanaConfig;
  private memoryConsolidation?: MemoryConsolidationScheduler;
  private mcpTools: Tool[] = [];

  constructor(options: CreateKanaConversationHostOptions<TConfiguration> = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.launchMode = options.launchMode ?? "normal";
    this.configStore = (options.createConfigStore ?? createKanaConfigStore)(this.env);
    this.configData = this.configStore.load();
    this.createAgentProduct = options.createAgent ?? createKanaConversationAgent;
    this.enableScheduledWakeTool = options.enableScheduledWakeTool ?? true;
    this.applyAgentConfiguration = options.applyAgentConfiguration;
    this.sessionRegistry = new HostedSessionRegistry({
      env: this.env,
      launchMode: this.launchMode,
      logLevel: this.configData.logging.level,
      getSessionModel: () => ({
        provider: this.configData.agent.model.provider,
        model: this.configData.agent.model.name,
      }),
      getBackgroundJobMaxConcurrent: () => this.configData.agent.backgroundJobs.maxConcurrent,
    });
    this.toolApprovals = loadKanaToolApprovals(this.env);
    this.memoryConsolidationQueue = createMemoryConsolidationQueue();
    this.memoryConsolidation = this.createMemoryConsolidation(this.configData);
    this.wakeScheduler = createWakeScheduler();

    this.initialSession = this.sessionRegistry.initialize(options.session ?? { type: "new" });

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
    return this.sessionRegistry.resumeSessionId;
  }

  getLogger(): Logger {
    return this.sessionRegistry.getLogger();
  }

  getBackgroundJobs(sessionId: string): BackgroundJobClient | undefined {
    return this.sessionRegistry.getBackgroundJobs(sessionId);
  }

  disposeSession(
    sessionId: string,
    source: "session_disposal" | "shutdown",
    foregroundSettled?: Promise<void>,
  ): Promise<void> {
    return this.sessionRegistry.disposeSession(sessionId, source, foregroundSettled);
  }

  createAgent(options: KanaConversationHostAgentOptions<TConfiguration>) {
    const { configuration, onTodoStateCommitted, ...agentOptions } = options;
    const sessionBinding = this.sessionRegistry.createAgentBinding(
      options.sessionId,
      onTodoStateCommitted,
    );
    const kanaAgentOptions = this.createKanaAgentOptions(agentOptions, sessionBinding);

    let agent: Agent;
    if (configuration === undefined) {
      agent = this.createAgentProduct(this.configData, kanaAgentOptions);
    } else if (this.launchMode === "clean") {
      if (!this.applyAgentConfiguration) {
        throw new Error("This Kana conversation host does not support Agent reconfiguration.");
      }
      const nextConfig = structuredClone(this.configData);
      this.applyAgentConfiguration(nextConfig, configuration);
      const validatedConfig = validateKanaConfig(nextConfig);
      // Model changes remain useful within a temporary conversation, but the
      // clean-mode state boundary must not update the shared config store.
      agent = this.createAgentProduct(validatedConfig, kanaAgentOptions);
      this.configData = validatedConfig;
    } else {
      if (!this.applyAgentConfiguration) {
        throw new Error("This Kana conversation host does not support Agent reconfiguration.");
      }
      let nextAgent: Agent | undefined;
      const nextConfig = this.configStore.update((draft) => {
        this.applyAgentConfiguration?.(draft, configuration);
        nextAgent = this.createAgentProduct(draft, kanaAgentOptions);
      });
      if (!nextAgent) {
        throw new Error("Kana could not initialize the selected model.");
      }
      this.configData = nextConfig;
      agent = nextAgent;
    }

    // Session callbacks register candidates before ConversationRuntime builds
    // their Agent. Adopt the candidate only after every constructor succeeds.
    this.sessionRegistry.activate(options.sessionId);
    return agent;
  }

  createNewSession(): { id: string } {
    return this.sessionRegistry.createNewSession();
  }

  forkSession(
    messages: Message[],
    contextCheckpoint: ContextCheckpoint | undefined,
    prompt: string,
  ): { id: string; todoState: KanaTodoItem[] } {
    return this.sessionRegistry.forkSession(messages, contextCheckpoint, prompt);
  }

  loadSession(sessionId: string): LoadKanaSessionResult {
    return this.sessionRegistry.loadSession(sessionId);
  }

  listSessions(): KanaSessionMetadata[] {
    return this.sessionRegistry.listSessions();
  }

  deleteSession(sessionId: string): Promise<boolean> {
    return this.sessionRegistry.deleteSession(sessionId);
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

  async close(): Promise<void> {
    const schedulers = [...this.memoryConsolidationSchedulers];
    this.memoryConsolidation = undefined;
    const schedulersSettled = Promise.all(schedulers.map((scheduler) => scheduler.close())).then(
      () => undefined,
    );

    try {
      await this.sessionRegistry.close(schedulersSettled);
    } finally {
      this.memoryConsolidationSchedulers.clear();
      await this.mcpRuntime.close();
    }
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
          const activeSession = this.sessionRegistry.getActiveSession();
          if (activeSession) {
            recordKanaAgentRunAccounting({
              sessionId: activeSession.id,
              cwd: activeSession.cwd,
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
    if (this.launchMode === "clean" && scope === "session") {
      throw new Error("Session usage is unavailable in clean mode.");
    }
    return loadKanaUsageSummary({
      scope,
      sessionId: scope === "session" ? this.sessionRegistry.activeId : undefined,
      cwd: process.cwd(),
      env: this.env,
    });
  }

  private createKanaAgentOptions(
    options: Pick<
      KanaConversationHostAgentOptions<TConfiguration>,
      | "beforeToolExecution"
      | "inbox"
      | "messages"
      | "contextCheckpoint"
      | "sessionId"
      | "resolveGoal"
      | "updateGoal"
    >,
    sessionBinding: HostedSessionAgentBinding,
  ): KanaAgentOptions {
    const session = sessionBinding.session;
    const logger = sessionBinding.logger;

    return {
      ...options,
      additionalTools: this.mcpTools,
      // Prompt assembly reads the host-owned MCP snapshot at each model step;
      // Agent construction still receives the initial list for synchronous state.
      resolveAdditionalTools: () => this.mcpTools,
      resolveTodoState: sessionBinding.resolveTodoState,
      env: this.env,
      launchMode: this.launchMode,
      logger,
      artifactStore: sessionBinding.artifactStore,
      backgroundJobs: sessionBinding.backgroundJobs,
      wakeScheduler: this.enableScheduledWakeTool ? this.wakeScheduler : undefined,
      messages: options.messages ?? sessionBinding.messages,
      inbox: options.inbox,
      contextCheckpoint: options.contextCheckpoint ?? sessionBinding.contextCheckpoint,
      journal: sessionBinding.journal,
      commitTodoState: sessionBinding.commitTodoState,
      onRunCommitted: ({ messages, compactions, state, event }) => {
        if (!session) {
          throw new Error("Cannot complete an Agent run without an active session.");
        }
        if (!session.persistent) {
          return;
        }

        try {
          recordKanaAgentRunAccounting({
            sessionId: session.id,
            cwd: session.cwd,
            agentKind: "main",
            outcome: event.reason,
            messages,
            model: state.model.metadata,
            additionalUsage: addCompactionUsage(compactions),
          });
        } catch (error) {
          logger.error("accounting.record_failed", {
            phase: "conversation_run",
            error,
          });
        }

        const accountingSession = {
          id: session.id,
          cwd: session.cwd,
        };
        void this.memoryConsolidation
          ?.schedule(messages, {
            logger,
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
            logger.error("memory_consolidation.failed", { error });
          });
      },
      onCompactionCommitted: ({ compaction, state }) => {
        if (!session) {
          throw new Error("Cannot persist context compaction without an active session.");
        }
        if (!session.persistent) {
          return;
        }

        try {
          recordKanaAgentRunAccounting({
            sessionId: session.id,
            cwd: session.cwd,
            agentKind: "main",
            outcome: "stop",
            messages: [],
            model: state.model.metadata,
            additionalUsage: compaction.usage,
          });
        } catch (error) {
          logger.error("accounting.record_failed", {
            phase: "manual_compaction",
            error,
          });
        }
      },
    };
  }

  private createMemoryConsolidation(config: KanaConfig): MemoryConsolidationScheduler | undefined {
    const scheduler =
      this.launchMode !== "clean" && config.memory.enabled
        ? createMemoryConsolidationScheduler(config, {
            env: this.env,
            queue: this.memoryConsolidationQueue,
          })
        : undefined;
    if (scheduler) {
      // Model reconfiguration can replace the active scheduler while an older
      // one still owns work, so the host retains every instance for shutdown.
      this.memoryConsolidationSchedulers.add(scheduler);
    }
    return scheduler;
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

  private assertCustomizationsAvailable(feature: string): void {
    if (this.launchMode === "clean") {
      throw new Error(`${feature} is unavailable in clean mode.`);
    }
  }
}

function createKanaConversationAgent(config: KanaConfig, options: KanaAgentOptions = {}): Agent {
  return createKanaAgent(
    config.agent,
    {
      providers: config.provider,
      memoryEnabled: config.memory.enabled,
    },
    options,
  );
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
