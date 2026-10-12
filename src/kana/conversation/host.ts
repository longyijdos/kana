import type { Agent, ContextCheckpoint, PromptSystemSection } from "@/agent";
import { addModelUsage, type ModelUsage, type ToolCallContent } from "@/core";
import type { Logger } from "@/logging";
import type { McpOAuthHttpDiagnosticEvent, McpToolRegistry, McpToolSource } from "@/mcp";
import type { OAuthTokenStatus } from "@/oauth";
import { formatError, shortId } from "@/utils";
import {
  type KanaUsageScope,
  type KanaUsageSummary,
  loadKanaUsageSummary,
  recordKanaAgentRunAccounting,
} from "../accounting";
import { createKanaAgent, type KanaAgentOptions } from "../agent";
import { createKanaOAuthTokenStore } from "../auth";
import {
  createKanaConfigStore,
  type KanaConfig,
  type KanaConfigDraft,
  type KanaConfigStore,
  type KanaNotificationConfig,
  type KanaToolApprovalConfig,
  type KanaTuiConfig,
  validateKanaConfig,
} from "../config";
import {
  type KanaCustomProviderSnapshot,
  loadKanaCustomProviderSnapshot,
} from "../custom-provider";
import type { KanaLaunchMode } from "../launch-mode";
import {
  authorizeKanaMcpServer,
  createKanaMcpConfigurationStore,
  createKanaMcpRuntime,
  type KanaMcpConfigurationStore,
  type KanaMcpRuntime,
  type KanaMcpRuntimeProgressEvent,
  type KanaMcpRuntimeSnapshot,
  type KanaMcpServerActivation,
  resolveKanaMcpServerActivations,
  signOutKanaMcpServer,
} from "../mcp";
import {
  createMemoryConsolidationQueue,
  createMemoryConsolidationScheduler,
  type KanaMemoryEntry,
  loadKanaMemory,
  type MemoryConsolidationActivity,
  type MemoryConsolidationEvent,
  type MemoryConsolidationQueue,
  type MemoryConsolidationScheduler,
  runFullMemoryConsolidation,
} from "../memory";
import { getKanaModelManagement, type KanaModelManagement } from "../model-management";
import { getKanaConfigPaths } from "../path";
import { loadKanaInstructionSections } from "../prompt";
import type { LoadKanaSessionResult } from "../session";
import {
  createKanaSkillStore,
  type KanaSkillStore,
  type LoadKanaSkillActivationsResult,
} from "../skills";
import {
  createKanaSubagentJournal,
  finalOutput,
  type KanaSubagentRunContext,
  type KanaSubagentRunResult,
  type LoadKanaSubagentProfilesResult,
  loadKanaSubagentProfiles,
} from "../subagents";
import type { KanaTodoStateChange } from "../todo";
import {
  createKanaToolApprovalStore,
  type KanaToolApprovalStore,
  type KanaToolApprovals,
} from "../tool-approval";
import type { KanaGoalSnapshot, KanaGoalUpdate } from "./goal-controller";
import { type HostedSessionAgentBinding, HostedSessionRegistry } from "./hosted-session-registry";
import {
  type ConversationAgentIdentity,
  ConversationRuntime,
  type ConversationRuntimeOptions,
  type ConversationSessionSnapshot,
} from "./runtime";
import { createWakeScheduler, type WakeScheduler } from "./wake-scheduler";

export type KanaConversationHostSession =
  | { type: "new" }
  | { type: "resume"; sessionId: string }
  | { type: "none" };

export type KanaConversationHostAgentOptions<TConfiguration> = Pick<
  KanaAgentOptions,
  "beforeToolExecution" | "inbox" | "messages" | "contextCheckpoint"
> & {
  bindBeforeToolExecution?: (
    agent: ConversationAgentIdentity,
  ) => KanaAgentOptions["beforeToolExecution"];
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
  configOverrides?: readonly string[];
  enableScheduledWakeTool?: boolean;
  enableUserTasks?: boolean;
  applyAgentConfiguration?: (draft: KanaConfigDraft, configuration: TConfiguration) => void;
  onMcpProgress?: (event: KanaMcpRuntimeProgressEvent) => void;
  openMcpOAuthAuthorizationUrl?: (serverId: string, url: string) => Promise<void>;
  onMcpOAuthDiagnostic?: (serverId: string, event: McpOAuthHttpDiagnosticEvent) => void;
  createAgent?: KanaAgentProductFactory;
  createConfigStore?: (env: NodeJS.ProcessEnv, overrides?: readonly string[]) => KanaConfigStore;
  createMcpRuntime?: typeof createKanaMcpRuntime;
};

export class KanaConversationHost<TConfiguration = never> {
  readonly initialSession?: LoadKanaSessionResult;
  readonly launchMode: KanaLaunchMode;
  readonly wakeScheduler: WakeScheduler;

  private readonly env: NodeJS.ProcessEnv;
  private readonly configStore: KanaConfigStore;
  private readonly toolApprovalStore: KanaToolApprovalStore;
  private readonly createAgentProduct: KanaAgentProductFactory;
  private readonly enableScheduledWakeTool: boolean;
  private readonly enableUserTasks: boolean;
  private readonly applyAgentConfiguration?: (
    draft: KanaConfigDraft,
    configuration: TConfiguration,
  ) => void;
  private readonly sessionRegistry: HostedSessionRegistry;
  private readonly memoryConsolidationQueue: MemoryConsolidationQueue;
  private readonly memoryConsolidationSchedulers = new Set<MemoryConsolidationScheduler>();
  private readonly memoryActivityListeners = new Set<(event: MemoryConsolidationEvent) => void>();
  private readonly oauthTokenStore;
  private readonly customProviderSnapshot: KanaCustomProviderSnapshot;
  private readonly subagentProfileSnapshot: LoadKanaSubagentProfilesResult;
  private readonly instructionSections: readonly PromptSystemSection[];
  private readonly mcpRuntime: KanaMcpRuntime;
  private configData: KanaConfig;
  private memoryConsolidation?: MemoryConsolidationScheduler;
  // Persistence and user customizations exist only in normal launches; clean
  // mode leaves them out instead of checking the mode at each use.
  private readonly persistent: boolean;
  private readonly customizations?: KanaHostCustomizations;

  constructor(options: CreateKanaConversationHostOptions<TConfiguration> = {}) {
    this.env = { ...(options.env ?? process.env) };
    this.launchMode = options.launchMode ?? "normal";
    this.persistent = this.launchMode !== "clean";
    this.configStore = (options.createConfigStore ?? createKanaConfigStore)(
      this.env,
      options.configOverrides,
    );
    this.configData = this.configStore.load();
    this.toolApprovalStore = createKanaToolApprovalStore(this.env);
    this.customProviderSnapshot = loadKanaCustomProviderSnapshot(
      getKanaConfigPaths(this.env).customProviderPath,
    );
    this.customizations = this.persistent
      ? {
          mcpConfiguration: createKanaMcpConfigurationStore(this.env),
          skills: createKanaSkillStore({ cwd: process.cwd(), env: this.env }),
        }
      : undefined;
    this.subagentProfileSnapshot = this.persistent
      ? loadKanaSubagentProfiles({ env: this.env })
      : { profiles: [], diagnostics: [] };
    this.instructionSections = this.persistent
      ? loadKanaInstructionSections({ cwd: process.cwd(), env: this.env })
      : [];
    this.createAgentProduct = options.createAgent ?? createKanaConversationAgent;
    this.enableScheduledWakeTool = options.enableScheduledWakeTool ?? true;
    this.enableUserTasks = options.enableUserTasks ?? false;
    this.applyAgentConfiguration = options.applyAgentConfiguration;
    this.sessionRegistry = new HostedSessionRegistry({
      env: this.env,
      persistent: this.persistent,
      logLevel: this.configData.logging.level,
      getBackgroundJobMaxConcurrent: () => this.configData.agent.backgroundJobs.maxConcurrent,
      getSubagentMaxLive: () => this.configData.agent.subagents.maxLive,
    });
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
      configurationSource: {
        getConfig: () => this.requireCustomizations("MCP").mcpConfiguration.getConfig(),
        getActivationState: () =>
          this.requireCustomizations("MCP").mcpConfiguration.getActivationState(),
      },
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
    return this.configData;
  }

  get approvalConfig(): KanaToolApprovalConfig {
    return this.configData.approval;
  }

  get notificationConfig(): KanaNotificationConfig {
    return this.configData.notification;
  }

  get tuiConfig(): KanaTuiConfig {
    return this.configData.tui;
  }

  get toolApprovals(): KanaToolApprovals {
    return this.toolApprovalStore.load();
  }

  getModelManagement(): KanaModelManagement {
    return getKanaModelManagement(this.configData, this.env, this.customProviderSnapshot);
  }

  get resumeSessionId(): string | undefined {
    return this.sessionRegistry.resumeSessionId;
  }

  getLogger(): Logger {
    return this.sessionRegistry.getLogger();
  }

  // Session, Agent, and background-work callbacks every frontend passes to its
  // ConversationRuntime. User tasks are offered only when the host enables them.
  get runtimeOptions(): KanaHostRuntimeOptions<TConfiguration> {
    const registry = this.sessionRegistry;
    return {
      initialSession: this.initialSession && toSessionSnapshot(this.initialSession),
      getSessionTimeline: (sessionId) => registry.getSessionTimeline(sessionId),
      createAgent: (options) => this.createAgent(options),
      createNewSession: () => registry.createNewSession(),
      forkSession: (messages, checkpoint, prompt) =>
        registry.forkSession(messages, checkpoint, prompt),
      loadSession: (sessionId) => toSessionSnapshot(this.loadSession(sessionId)),
      listSessions: () => registry.listSessions(),
      deleteSession: (sessionId) => registry.deleteSession(sessionId),
      getBackgroundJobs: (sessionId) => registry.getBackgroundJobs(sessionId),
      getSubagents: (sessionId) => registry.getSubagents(sessionId),
      ...(this.enableUserTasks
        ? { getUserTasks: (sessionId: string) => registry.getUserTasks(sessionId) }
        : {}),
      disposeSession: (sessionId, source, foregroundSettled) =>
        registry.disposeSession(sessionId, source, foregroundSettled),
      wakeScheduler: this.wakeScheduler,
      goalMaxRounds: this.configData.agent.goalMaxRounds,
      getLogger: () => this.getLogger(),
    };
  }

  createRuntime(frontend: KanaRuntimeFrontendOptions = {}): ConversationRuntime<TConfiguration> {
    return new ConversationRuntime({ ...this.runtimeOptions, ...frontend });
  }

  loadSubagentProfiles(): LoadKanaSubagentProfilesResult {
    return this.subagentProfileSnapshot;
  }

  loadSkills(): LoadKanaSkillActivationsResult {
    return this.requireCustomizations("Skills").skills.load();
  }

  saveEnabledGlobalSkillNames(names: readonly string[]): void {
    this.requireCustomizations("Skills").skills.saveEnabledGlobalNames(names);
  }

  addTrustedShellCommand(command: string): KanaToolApprovals {
    return this.toolApprovalStore.addTrustedShellCommand(command);
  }

  createAgent(options: KanaConversationHostAgentOptions<TConfiguration>) {
    const { configuration, onTodoStateCommitted, ...agentOptions } = options;
    const sessionBinding = this.sessionRegistry.createAgentBinding(
      options.sessionId,
      onTodoStateCommitted,
    );
    const createAgent = (config: KanaConfig): Agent => {
      const rememberedEntries: KanaMemoryEntry[] = [];
      const agent = this.createAgentProduct(
        config,
        this.createKanaAgentOptions(agentOptions, sessionBinding, config, rememberedEntries),
      );
      agent.subscribe((event) => {
        if (event.type === "agent_start") rememberedEntries.length = 0;
      });
      return agent;
    };

    let agent: Agent;
    if (configuration === undefined) {
      agent = createAgent(this.configData);
    } else if (!this.persistent) {
      if (!this.applyAgentConfiguration) {
        throw new Error("This Kana conversation host does not support Agent reconfiguration.");
      }
      const draft = structuredClone(this.configData) as KanaConfigDraft;
      this.applyAgentConfiguration(draft, configuration);
      const validatedConfig = validateKanaConfig(draft);
      // Model changes remain useful within a temporary conversation, but the
      // clean-mode state boundary must not update the shared config store.
      agent = createAgent(validatedConfig);
      this.configData = validatedConfig;
    } else {
      if (!this.applyAgentConfiguration) {
        throw new Error("This Kana conversation host does not support Agent reconfiguration.");
      }
      let nextAgent: Agent | undefined;
      const nextConfig = this.configStore.update((draft) => {
        this.applyAgentConfiguration?.(draft, configuration);
        nextAgent = createAgent(draft);
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

  loadSession(sessionId: string): LoadKanaSessionResult {
    return this.sessionRegistry.loadSession(sessionId);
  }

  async startMcp(signal?: AbortSignal): Promise<KanaMcpRuntimeSnapshot> {
    return this.runMcpOperation("start", signal);
  }

  async reloadMcp(signal?: AbortSignal): Promise<KanaMcpRuntimeSnapshot> {
    return this.runMcpOperation("reload", signal);
  }

  closeMcp(): Promise<void> {
    return this.mcpRuntime.close();
  }

  getMemoryActivity(): MemoryConsolidationActivity[] {
    return [...this.memoryConsolidationSchedulers].flatMap((scheduler) => scheduler.getActivity());
  }

  subscribeMemoryActivity(listener: (event: MemoryConsolidationEvent) => void): () => void {
    this.memoryActivityListeners.add(listener);
    return () => this.memoryActivityListeners.delete(listener);
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
      this.memoryActivityListeners.clear();
      await this.mcpRuntime.close();
    }
  }

  getMcpToolSource(call: ToolCallContent): McpToolSource | undefined {
    if (call.name !== "mcp_call" || !call.args || typeof call.args !== "object") return undefined;
    const { server, tool } = call.args as Record<string, unknown>;
    return typeof server === "string" && typeof tool === "string"
      ? { serverId: server, remoteToolName: tool }
      : undefined;
  }

  loadMcpServers(): KanaMcpServerActivation[] {
    const configuration = this.customizations?.mcpConfiguration;
    return configuration === undefined
      ? []
      : resolveKanaMcpServerActivations(
          configuration.getConfig(),
          configuration.getActivationState(),
          this.env,
        );
  }

  saveEnabledMcpServerIds(serverIds: string[]): void {
    this.requireCustomizations("MCP management").mcpConfiguration.saveActivationState({
      enabledServers: serverIds,
    });
  }

  authorizeMcpServer(
    serverId: string,
    openAuthorizationUrl: (url: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<OAuthTokenStatus> {
    return authorizeKanaMcpServer(serverId, {
      env: this.env,
      getLogger: () => this.getLogger(),
      tokenStore: this.oauthTokenStore,
      config: this.requireCustomizations("MCP authorization").mcpConfiguration.getConfig(),
      signal,
      openAuthorizationUrl,
    });
  }

  signOutMcpServer(serverId: string): Promise<OAuthTokenStatus> {
    return signOutKanaMcpServer(serverId, {
      env: this.env,
      getLogger: () => this.getLogger(),
      tokenStore: this.oauthTokenStore,
      config: this.requireCustomizations("MCP authorization").mcpConfiguration.getConfig(),
    });
  }

  async compactMemory(
    target: "global" | "project" | "both",
    userRequest: string | undefined,
    signal: AbortSignal,
  ): Promise<KanaMemoryCompactSummary[]> {
    this.requireCustomizations("Memory");
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
              customProviderSnapshot: this.customProviderSnapshot,
              userRequest,
              signal,
              logger,
            }),
          );
          const activeSession = this.sessionRegistry.getActiveSession();
          if (activeSession?.persistent) {
            recordAccounting(logger, "manual_memory_consolidation", {
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
            error: formatError(error),
          };
        }
      }),
    );
  }

  loadMemory(target: "global" | "project"): string {
    this.requireCustomizations("Memory");
    return loadKanaMemory(target, { cwd: process.cwd(), env: this.env });
  }

  loadUsage(scope: KanaUsageScope): KanaUsageSummary {
    if (!this.persistent && scope === "session") {
      throw new Error("Session usage is unavailable in clean mode.");
    }
    return loadKanaUsageSummary({
      scope,
      sessionId: scope === "session" ? this.sessionRegistry.activeId : undefined,
      cwd: process.cwd(),
      env: this.env,
      logger: this.getLogger(),
    });
  }

  private createKanaAgentOptions(
    options: Pick<
      KanaConversationHostAgentOptions<TConfiguration>,
      | "beforeToolExecution"
      | "bindBeforeToolExecution"
      | "inbox"
      | "messages"
      | "contextCheckpoint"
      | "sessionId"
      | "resolveGoal"
      | "updateGoal"
    >,
    sessionBinding: HostedSessionAgentBinding,
    config: KanaConfig,
    rememberedEntries: KanaMemoryEntry[],
  ): KanaAgentOptions {
    const session = sessionBinding.session;
    const logger = sessionBinding.logger;
    const { bindBeforeToolExecution, ...agentOptions } = options;
    const bindToolExecution = bindBeforeToolExecution ?? (() => agentOptions.beforeToolExecution);

    return {
      ...agentOptions,
      resolveMcp: this.resolveMcp,
      memoryEnabled: this.customizations !== undefined && config.memory.enabled,
      resolveTodoState: sessionBinding.resolveTodoState,
      env: this.env,
      onMemoryRecorded: (entry) => rememberedEntries.push(entry),
      logger,
      artifactStore: sessionBinding.artifactStore,
      backgroundJobs: sessionBinding.backgroundJobs,
      subagents: sessionBinding.subagents,
      userTasks: this.enableUserTasks ? sessionBinding.userTasks : undefined,
      subagentProfiles: this.subagentProfileSnapshot.profiles,
      skills: this.customizations?.skills.load().skills.filter((skill) => skill.enabled) ?? [],
      customProviderSnapshot: this.customProviderSnapshot,
      instructionSections: this.instructionSections,
      runSubagent: (context) => this.runSubagent(context, bindToolExecution, config, logger),
      wakeScheduler: this.enableScheduledWakeTool ? this.wakeScheduler : undefined,
      messages: options.messages ?? sessionBinding.messages,
      inbox: options.inbox,
      contextCheckpoint: options.contextCheckpoint ?? sessionBinding.contextCheckpoint,
      journal: sessionBinding.journal,
      commitTodoState: sessionBinding.commitTodoState,
      onRunCommitted: ({ messages, compactions, state, event }) => {
        if (!session?.persistent) {
          return;
        }

        recordAccounting(logger, "conversation_run", {
          sessionId: session.id,
          cwd: session.cwd,
          agentKind: "main",
          outcome: event.reason,
          messages,
          model: state.model.metadata,
          additionalUsage: addCompactionUsage(compactions),
        });

        const accountingSession = {
          id: session.id,
          cwd: session.cwd,
        };
        void this.memoryConsolidation
          ?.schedule(rememberedEntries.splice(0), {
            logger,
            onCompleted: (scope, result) =>
              recordAccounting(logger, "automatic_memory_consolidation", {
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
        if (!session?.persistent) {
          return;
        }

        recordAccounting(logger, "manual_compaction", {
          sessionId: session.id,
          cwd: session.cwd,
          agentKind: "main",
          outcome: "stop",
          messages: [],
          model: state.model.metadata,
          additionalUsage: compaction.usage,
        });
      },
    };
  }

  private async runSubagent(
    context: KanaSubagentRunContext,
    bindBeforeToolExecution: (
      agent: ConversationAgentIdentity,
    ) => KanaAgentOptions["beforeToolExecution"],
    parentConfig: KanaConfig,
    logger: Logger,
  ): Promise<KanaSubagentRunResult> {
    const { model } = context.profile;
    const config: KanaConfig = {
      ...parentConfig,
      agent: {
        ...parentConfig.agent,
        toolResultArtifacts: false,
        ...(model === undefined
          ? {}
          : {
              model: {
                provider: model.provider,
                name: model.name,
                reasoningEffort: model.reasoningEffort,
              },
            }),
      },
    };
    let terminalReason: KanaSubagentRunResult["terminalReason"];
    const journal = createKanaSubagentJournal({
      agentId: context.agentId,
      owner: context.owner,
      profile: context.profile,
      task: context.task,
      spawnToolCallId: context.spawnToolCallId,
      env: this.env,
    });
    const agent = this.createAgentProduct(config, {
      env: this.env,
      logger,
      resolveMcp: this.resolveMcp,
      subagentProfile: context.profile,
      customProviderSnapshot: this.customProviderSnapshot,
      journal,
      beforeToolExecution: bindBeforeToolExecution({
        id: context.agentId,
        label: `${context.profile.name} · ${shortId(context.agentId)}`,
        kind: "subagent",
        profileName: context.profile.name,
      }),
      onRunCommitted: ({ messages, compactions, state, event }) => {
        terminalReason = event.reason;
        if (!context.owner.persistent) return;
        recordAccounting(logger, "subagent_run", {
          sessionId: context.owner.sessionId,
          cwd: context.owner.cwd,
          agentKind: "subagent",
          outcome: event.reason,
          messages,
          model: state.model.metadata,
          additionalUsage: addCompactionUsage(compactions),
        });
      },
    });
    context.setLiveSnapshot(() => {
      const state = agent.state;
      return {
        messages: [...state.messages, ...(state.streamingMessage ? [state.streamingMessage] : [])],
        model: { provider: state.model.metadata.provider, model: state.model.metadata.model },
      };
    });
    const abort = (): void => agent.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) agent.abort();
    try {
      await agent.prompt(context.task);
      const messages = agent.state.messages;
      return {
        status:
          context.signal.aborted || terminalReason === "aborted"
            ? "cancelled"
            : terminalReason === "error"
              ? "errored"
              : "completed",
        output: finalOutput(messages),
        messages,
        model: {
          provider: agent.state.model.metadata.provider,
          model: agent.state.model.metadata.model,
        },
        terminalReason,
      };
    } catch (error) {
      const messages = agent.state.messages;
      return {
        status: context.signal.aborted ? "cancelled" : "errored",
        output: finalOutput(messages),
        messages,
        model: {
          provider: agent.state.model.metadata.provider,
          model: agent.state.model.metadata.model,
        },
        terminalReason,
        error: formatError(error),
      };
    } finally {
      context.signal.removeEventListener("abort", abort);
      agent.abort();
      await agent.waitForIdle();
    }
  }

  private createMemoryConsolidation(config: KanaConfig): MemoryConsolidationScheduler | undefined {
    const scheduler =
      this.customizations && config.memory.enabled
        ? createMemoryConsolidationScheduler(config, {
            env: this.env,
            customProviderSnapshot: this.customProviderSnapshot,
            queue: this.memoryConsolidationQueue,
          })
        : undefined;
    if (scheduler) {
      // Model reconfiguration can replace the active scheduler while an older
      // one still owns work, so the host retains every instance for shutdown.
      this.memoryConsolidationSchedulers.add(scheduler);
      scheduler.subscribe((event) => {
        for (const listener of this.memoryActivityListeners) listener(event);
      });
    }
    return scheduler;
  }

  private async runMcpOperation(
    operation: "start" | "reload",
    signal?: AbortSignal,
  ): Promise<KanaMcpRuntimeSnapshot> {
    if (!this.customizations) {
      this.getLogger().info("mcp.skipped", {
        operation,
        reason: "clean_mode",
      });
      return {
        diagnostics: [],
        selectedServerIds: [],
      };
    }

    try {
      const snapshot = await (operation === "start"
        ? this.mcpRuntime.start(signal === undefined ? {} : { signal })
        : this.mcpRuntime.reload(signal === undefined ? {} : { signal }));
      this.getLogger().info(operation === "start" ? "mcp.started" : "mcp.reloaded", {
        configuredServerCount: snapshot.selectedServerIds.length,
        readyServerCount: snapshot.diagnostics.filter((diagnostic) => diagnostic.status === "ready")
          .length,
        toolCount: snapshot.diagnostics
          .filter((diagnostic) => diagnostic.status === "ready")
          .reduce((count, diagnostic) => count + diagnostic.toolCount, 0),
      });
      return snapshot;
    } catch (error) {
      if (signal?.aborted) {
        this.getLogger().info("mcp.operation_cancelled", { operation });
      }
      throw error;
    }
  }

  // MCP tools exist only when customizations are loaded; clean mode never
  // starts the MCP runtime.
  private get resolveMcp(): (() => McpToolRegistry | undefined) | undefined {
    return this.customizations ? () => this.mcpRuntime.registry : undefined;
  }

  private requireCustomizations(feature: string): KanaHostCustomizations {
    if (!this.customizations) {
      throw new Error(`${feature} is unavailable in clean mode.`);
    }
    return this.customizations;
  }
}

type KanaHostCustomizations = {
  readonly mcpConfiguration: KanaMcpConfigurationStore;
  readonly skills: KanaSkillStore;
};

function createKanaConversationAgent(config: KanaConfig, options: KanaAgentOptions = {}): Agent {
  return createKanaAgent(config.agent, { providers: config.provider }, options);
}

export function createKanaConversationHost<TConfiguration = never>(
  options: CreateKanaConversationHostOptions<TConfiguration> = {},
): KanaConversationHost<TConfiguration> {
  return new KanaConversationHost(options);
}

function addCompactionUsage(compactions: readonly ContextCheckpoint[]): ModelUsage | undefined {
  return compactions.reduce<ModelUsage | undefined>(
    (total, compaction) => (compaction.usage ? addModelUsage(total, compaction.usage) : total),
    undefined,
  );
}

// Frontend-specific runtime behavior; everything else comes from the host.
type KanaRuntimeFrontendOptions = Pick<
  ConversationRuntimeOptions<never>,
  "backgroundJobCompletionRuns" | "subagentCompletionRuns" | "scheduledRuns" | "canStartQueuedRun"
>;

export type KanaHostRuntimeOptions<TConfiguration> = Omit<
  ConversationRuntimeOptions<TConfiguration>,
  keyof KanaRuntimeFrontendOptions
> &
  Required<
    Pick<
      ConversationRuntimeOptions<TConfiguration>,
      | "getSessionTimeline"
      | "listSessions"
      | "deleteSession"
      | "getBackgroundJobs"
      | "getSubagents"
      | "disposeSession"
    >
  >;

function toSessionSnapshot(session: LoadKanaSessionResult): ConversationSessionSnapshot {
  return {
    id: session.metadata.id,
    messages: session.messages,
    timeline: session.timeline,
    todoState: session.todoState,
    contextCheckpoint: session.contextCheckpoint,
  };
}

// Accounting is a best-effort ledger: a failed write is logged and never fails
// the run that produced it.
function recordAccounting(
  logger: Logger,
  phase: string,
  record: Parameters<typeof recordKanaAgentRunAccounting>[0],
): void {
  try {
    recordKanaAgentRunAccounting(record);
  } catch (error) {
    logger.error("accounting.record_failed", { phase, error });
  }
}
