import type { ContextCheckpoint } from "@/agent";
import { addModelUsage, type Message, type ModelUsage } from "@/core";
import {
  authorizeKanaMcpServer,
  createKanaAgent,
  createKanaConfigStore,
  createKanaMcpRuntime,
  createKanaOAuthTokenStore,
  createKanaSession,
  createKanaSessionJournal,
  createMemoryConsolidationQueue,
  createMemoryConsolidationScheduler,
  createWakeScheduler,
  deleteKanaSession,
  getActiveKanaModelConfig,
  getKanaSessionLogPath,
  KANA_BUILT_IN_TOOL_NAMES,
  type KanaAgentOptions,
  type LoadKanaSessionResult,
  listKanaSessions,
  loadKanaMcpServerActivations,
  loadKanaMemory,
  loadKanaSession,
  loadKanaSkillActivations,
  loadKanaToolApprovals,
  loadKanaUsageSummary,
  openKanaOAuthAuthorizationUrl,
  recordKanaAgentRunAccounting,
  runFullMemoryConsolidation,
  saveEnabledGlobalSkillNames,
  saveKanaMcpActivationState,
  signOutKanaMcpServer,
} from "@/kana";
import { createNoopLogger, createSessionLogManager } from "@/logging";
import type { Tool } from "@/tools";
import { KanaTuiApp } from "./app/app";
import type { MemoryCompactSummary } from "./app/memory-compact-controller";
import { applyTuiModelSelection } from "./app/model-selection";
import {
  formatMcpLifecycleStatus,
  formatMcpReloadSummary,
  formatMcpStartupSummary,
  formatMcpStartupWarnings,
} from "./mcp-lifecycle-status";
import { registerTuiProcessSignals } from "./process-lifecycle";
import { ProcessTerminal } from "./runtime";

export type StartTuiOptions = {
  initialPrompt?: string;
  resumeSessionId?: string;
  showResumePicker?: boolean;
};

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  const configStore = createKanaConfigStore();
  let config = configStore.load();
  const logManager = createSessionLogManager({ level: config.logging.level });
  const toolApprovals = loadKanaToolApprovals();
  const memoryConsolidationQueue = createMemoryConsolidationQueue();
  const wakeScheduler = createWakeScheduler();
  let memoryConsolidation = config.memory.enabled
    ? createMemoryConsolidationScheduler(config, { queue: memoryConsolidationQueue })
    : undefined;
  const createSession = (parentSessionPath?: string, title?: string) => {
    const modelConfig = getActiveKanaModelConfig(config);
    return createKanaSession({
      title,
      model: {
        provider: config.provider.active,
        model: modelConfig.name,
      },
      parentSessionPath,
    });
  };
  let session: LoadKanaSessionResult | undefined = options.showResumePicker
    ? undefined
    : options.resumeSessionId
      ? loadKanaSession(options.resumeSessionId)
      : {
          metadata: createSession(),
          messages: [],
          timeline: [],
        };
  let sessionJournal = session
    ? createKanaSessionJournal(session.metadata, session.timeline)
    : undefined;
  let sessionLogger = createNoopLogger();
  const activateSessionLogger = (nextSession: typeof session): void => {
    sessionLogger = nextSession
      ? logManager.forSession({
          path: getKanaSessionLogPath(nextSession.metadata.id, { cwd: nextSession.metadata.cwd }),
          sessionId: nextSession.metadata.id,
        })
      : createNoopLogger();
  };
  activateSessionLogger(session);
  if (session) {
    sessionLogger.info("session.started", { resumed: options.resumeSessionId !== undefined });
    if (session.recoveredInterruptedTurn) {
      sessionLogger.warn("session.interrupted_turn_recovered", {
        unknownToolCallCount: session.recoveredInterruptedTurn.unknownToolCallCount,
      });
    }
    if (session.recoveredIncompleteTail) {
      sessionLogger.warn("session.incomplete_tail_recovered");
    }
  }
  let resumeSessionId = options.resumeSessionId ? session?.metadata.id : undefined;
  let pendingForkMessages: Message[] | undefined;
  let pendingForkCheckpoint: ContextCheckpoint | undefined;
  const terminal = new ProcessTerminal(config.notification);
  let mcpTools: Tool[] = [];
  let updateMcpLifecycleStatus: ((status: string) => void) | undefined;
  let app: KanaTuiApp | undefined;
  const oauthTokenStore = createKanaOAuthTokenStore({ getLogger: () => sessionLogger });
  const mcpRuntime = createKanaMcpRuntime({
    reservedToolNames: KANA_BUILT_IN_TOOL_NAMES,
    getLogger: () => sessionLogger,
    oauthTokenStore,
    openOAuthAuthorizationUrl: async (serverId, url) => {
      app?.showMcpOAuthAuthorization(serverId, url);
      await openKanaOAuthAuthorizationUrl(url, { getLogger: () => sessionLogger });
    },
    onOAuthDiagnostic: (serverId, event) => {
      app?.handleMcpOAuthDiagnostic(serverId, event);
    },
    onProgress: (event) => {
      const status = formatMcpLifecycleStatus(event);
      if (status === undefined) {
        return;
      }

      if (event.runtimeOperation !== "close") {
        updateMcpLifecycleStatus?.(status);
      } else {
        app?.showShutdownStatus(status);
      }
    },
  });
  let removeProcessSignals = (): void => {};
  const closeMcpRuntime = async (): Promise<void> => {
    removeProcessSignals();
    await mcpRuntime.close();
  };
  const runMcpRuntimeOperation = async (
    operation: "start" | "reload",
    onProgress: (status: string) => void,
  ): Promise<{ status?: string; warnings: string[] }> => {
    updateMcpLifecycleStatus = onProgress;
    try {
      const snapshot = await (operation === "start" ? mcpRuntime.start() : mcpRuntime.reload());
      mcpTools = snapshot.tools;
      sessionLogger.info(operation === "start" ? "mcp.started" : "mcp.reloaded", {
        configuredServerCount: snapshot.selectedServerIds.length,
        readyServerCount: snapshot.diagnostics.filter((diagnostic) => diagnostic.status === "ready")
          .length,
        toolCount: mcpTools.length,
      });
      return {
        ...(snapshot.selectedServerIds.length === 0 && operation === "start"
          ? {}
          : {
              status:
                operation === "start"
                  ? formatMcpStartupSummary(snapshot.diagnostics, mcpTools.length)
                  : formatMcpReloadSummary(snapshot.diagnostics, mcpTools.length),
            }),
        warnings: formatMcpStartupWarnings(snapshot.diagnostics),
      };
    } catch (error) {
      mcpTools = mcpRuntime.tools;
      throw error;
    } finally {
      updateMcpLifecycleStatus = undefined;
    }
  };
  const loadMcpTools = (onProgress: (status: string) => void) =>
    runMcpRuntimeOperation("start", onProgress);
  const reloadMcpTools = (onProgress: (status: string) => void) =>
    runMcpRuntimeOperation("reload", onProgress);

  app = await createTuiAppWithCleanup(
    closeMcpRuntime,
    (agentOptions) => {
      // Each Agent retains this concrete logger for its full lifetime. It must
      // never resolve the active session again after an asynchronous run starts.
      const agentLogger = sessionLogger;
      const agentSession = session;
      const agentSessionJournal = sessionJournal;
      const { modelSelection, ...currentAgentOptions } = agentOptions;
      const appendTimeline = (entries: LoadKanaSessionResult["timeline"]): void => {
        if (!agentSession) {
          throw new Error("Cannot update a session journal without an active session.");
        }
        agentSession.timeline = [...agentSession.timeline, ...entries];
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
      const kanaAgentOptions: KanaAgentOptions = {
        ...currentAgentOptions,
        additionalTools: mcpTools,
        logger: agentLogger,
        wakeScheduler,
        sessionId: currentAgentOptions.sessionId,
        messages: currentAgentOptions.messages ?? agentSession?.messages,
        contextCheckpoint: currentAgentOptions.contextCheckpoint ?? agentSession?.contextCheckpoint,
        journal:
          agentSession && agentSessionJournal
            ? {
                startRun: ({ runId, messages }) => {
                  if (pendingForkMessages) {
                    const snapshotEntries = writeJournal("snapshot", () =>
                      agentSessionJournal.appendSnapshot(pendingForkMessages ?? [], {
                        compactions: pendingForkCheckpoint ? [pendingForkCheckpoint] : [],
                      }),
                    );
                    appendTimeline(snapshotEntries);
                    pendingForkMessages = undefined;
                    pendingForkCheckpoint = undefined;
                  }

                  const entries = writeJournal("start", () =>
                    agentSessionJournal.startTurn(runId, messages),
                  );
                  appendTimeline(entries);
                  agentSession.messages = [...agentSession.messages, ...structuredClone(messages)];
                  resumeSessionId = agentSession.metadata.id;
                },
                appendMessage: ({ runId, message }) => {
                  const entry = writeJournal("message", () =>
                    agentSessionJournal.appendMessage(runId, message),
                  );
                  appendTimeline([entry]);
                  agentSession.messages = [...agentSession.messages, structuredClone(message)];
                },
                appendCompaction: ({ runId, compaction }) => {
                  const entry = writeJournal("compaction", () =>
                    agentSessionJournal.appendCompaction(compaction, {
                      turnId: runId,
                    }),
                  );
                  appendTimeline([entry]);
                  agentSession.contextCheckpoint = structuredClone(compaction);
                },
                endRun: ({ runId, reason }) => {
                  const entry = writeJournal("end", () =>
                    agentSessionJournal.endTurn(runId, reason),
                  );
                  appendTimeline([entry]);
                },
              }
            : undefined,
        onRunCommitted: ({ messages, compactions, state, event }) => {
          if (!agentSession) {
            throw new Error("Cannot complete an Agent run without an active session.");
          }

          try {
            recordKanaAgentRunAccounting({
              sessionId: agentSession.metadata.id,
              cwd: agentSession.metadata.cwd,
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

          // Keep consolidation off the completed conversation's critical path;
          // the shared queue serializes each scope's read-modify-write jobs.
          const memoryLogger = agentLogger;
          const accountingSession = {
            id: agentSession.metadata.id,
            cwd: agentSession.metadata.cwd,
          };
          void memoryConsolidation
            ?.schedule(messages, {
              logger: memoryLogger,
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
              memoryLogger.error("memory_consolidation.failed", { error });
            });
        },
        onCompactionCommitted: ({ compaction, state }) => {
          if (!agentSession) {
            throw new Error("Cannot persist context compaction without an active session.");
          }

          try {
            recordKanaAgentRunAccounting({
              sessionId: agentSession.metadata.id,
              cwd: agentSession.metadata.cwd,
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

      if (!modelSelection) {
        return createKanaAgent(config, kanaAgentOptions);
      }

      let nextAgent: ReturnType<typeof createKanaAgent> | undefined;
      let nextMemoryConsolidation = memoryConsolidation;
      // Build every runtime object inside the config mutation. If construction
      // fails, ConfigStore never reaches its atomic write.
      const nextConfig = configStore.update((draft) => {
        applyTuiModelSelection(draft, modelSelection);
        nextAgent = createKanaAgent(draft, kanaAgentOptions);
        nextMemoryConsolidation = draft.memory.enabled
          ? createMemoryConsolidationScheduler(draft, {
              queue: memoryConsolidationQueue,
            })
          : undefined;
      });
      if (!nextAgent) {
        throw new Error("Kana could not initialize the selected model.");
      }

      config = nextConfig;
      memoryConsolidation = nextMemoryConsolidation;
      return nextAgent;
    },
    terminal,
    {
      initialSession: session
        ? {
            id: session.metadata.id,
            messages: session.messages,
            timeline: session.timeline,
            contextCheckpoint: session.contextCheckpoint,
          }
        : undefined,
      initialPrompt: options.initialPrompt,
      getResumeSessionId: () => resumeSessionId,
      startInResumePicker: options.showResumePicker,
      createNewSession: () => {
        session = {
          metadata: createSession(),
          messages: [],
          timeline: [],
        };
        sessionJournal = createKanaSessionJournal(session.metadata);
        activateSessionLogger(session);
        sessionLogger.info("session.created");
        resumeSessionId = undefined;
        pendingForkMessages = undefined;
        pendingForkCheckpoint = undefined;

        return {
          id: session.metadata.id,
        };
      },
      forkSession: (messages, contextCheckpoint, prompt) => {
        session ??= {
          metadata: createSession(),
          messages: [],
          timeline: [],
        };
        const source = session;

        session = {
          metadata: createSession(source.metadata.path, prompt),
          messages,
          timeline: [],
          contextCheckpoint,
        };
        sessionJournal = createKanaSessionJournal(session.metadata);
        activateSessionLogger(session);
        sessionLogger.info("session.forked", { sourceSessionId: source.metadata.id });
        resumeSessionId = undefined;
        pendingForkMessages = messages;
        pendingForkCheckpoint = contextCheckpoint
          ? {
              ...structuredClone(contextCheckpoint),
              baseCompactionId: undefined,
            }
          : undefined;

        return {
          id: session.metadata.id,
        };
      },
      listSessions: () => {
        const currentSessionId = session?.metadata.id;

        return listKanaSessions({ cwd: process.cwd() }).filter(
          (candidate) => candidate.id !== currentSessionId,
        );
      },
      loadSession: (sessionId) => {
        session = loadKanaSession(sessionId, { cwd: process.cwd() });
        sessionJournal = createKanaSessionJournal(session.metadata, session.timeline);
        activateSessionLogger(session);
        sessionLogger.info("session.resumed");
        if (session.recoveredInterruptedTurn) {
          sessionLogger.warn("session.interrupted_turn_recovered", {
            unknownToolCallCount: session.recoveredInterruptedTurn.unknownToolCallCount,
          });
        }
        if (session.recoveredIncompleteTail) {
          sessionLogger.warn("session.incomplete_tail_recovered");
        }
        resumeSessionId = session.metadata.id;
        pendingForkMessages = undefined;
        pendingForkCheckpoint = undefined;

        return {
          id: session.metadata.id,
          messages: session.messages,
          timeline: session.timeline,
          contextCheckpoint: session.contextCheckpoint,
        };
      },
      deleteSession: (sessionId) => deleteKanaSession(sessionId, { cwd: process.cwd() }),
      loadSkills: () => loadKanaSkillActivations({ cwd: process.cwd() }),
      saveEnabledGlobalSkills: (names) => saveEnabledGlobalSkillNames(names),
      toolApproval: {
        config: config.approval,
        approvals: toolApprovals,
        resolveToolSource: (toolName) => {
          const source = mcpRuntime.getToolSource(toolName);

          return source === undefined ? undefined : { kind: "mcp", ...source };
        },
      },
      notification: config.notification,
      wakeScheduler,
      getLogger: () => sessionLogger,
      compactMemory: async (target, userRequest, signal) => {
        const memoryLogger = sessionLogger;
        const scopes: Array<"global" | "project"> =
          target === "both" ? ["global", "project"] : [target];

        return Promise.all(
          scopes.map(async (scope): Promise<MemoryCompactSummary> => {
            try {
              const result = await memoryConsolidationQueue.enqueue(scope, () =>
                runFullMemoryConsolidation(config, {
                  scope,
                  cwd: process.cwd(),
                  userRequest,
                  signal,
                  logger: memoryLogger,
                }),
              );
              if (session) {
                recordKanaAgentRunAccounting({
                  sessionId: session.metadata.id,
                  cwd: session.metadata.cwd,
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
      },
      loadMemory: (target) => loadKanaMemory(target, { cwd: process.cwd() }),
      loadUsage: (scope) =>
        loadKanaUsageSummary({
          scope,
          sessionId: scope === "session" ? session?.metadata.id : undefined,
          cwd: process.cwd(),
        }),
      modelManagement: {
        getSettings: () => structuredClone(config),
      },
      loadExternalTools: loadMcpTools,
      mcpManagement: {
        loadServers: () => loadKanaMcpServerActivations(),
        saveEnabledServerIds: (serverIds) =>
          saveKanaMcpActivationState({ enabledServers: serverIds }),
        authorizeServer: (serverId, onAuthorizationUrl, signal) =>
          authorizeKanaMcpServer(serverId, {
            getLogger: () => sessionLogger,
            tokenStore: oauthTokenStore,
            signal,
            openAuthorizationUrl: async (url) => {
              onAuthorizationUrl(url);
              await openKanaOAuthAuthorizationUrl(url, { getLogger: () => sessionLogger });
            },
          }),
        signOutServer: (serverId) =>
          signOutKanaMcpServer(serverId, {
            getLogger: () => sessionLogger,
            tokenStore: oauthTokenStore,
          }),
        reloadExternalTools: reloadMcpTools,
      },
      onStop: closeMcpRuntime,
      onForceStop: () => {
        removeProcessSignals();
        terminal.stop();
        process.kill(process.pid, "SIGINT");
      },
    },
  );

  removeProcessSignals = registerTuiProcessSignals((signal) => {
    sessionLogger.info("tui.signal_received", { signal });
    void app?.stop();
  });

  try {
    app.start();
  } catch (error) {
    await app.stop();
    throw error;
  }
  await app.waitForStop();
}

function addCompactionUsage(compactions: ContextCheckpoint[]): ModelUsage | undefined {
  return compactions.reduce<ModelUsage | undefined>(
    (total, compaction) => (compaction.usage ? addModelUsage(total, compaction.usage) : total),
    undefined,
  );
}

async function createTuiAppWithCleanup(
  cleanup: () => Promise<void>,
  ...args: ConstructorParameters<typeof KanaTuiApp>
): Promise<KanaTuiApp> {
  try {
    return new KanaTuiApp(...args);
  } catch (error) {
    await cleanup();
    throw error;
  }
}
