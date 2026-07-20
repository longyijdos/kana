import type { Message } from "@/core";
import {
  appendKanaSessionMessages,
  createKanaAgent,
  createKanaMcpManager,
  createKanaSession,
  createMemoryConsolidationQueue,
  createMemoryConsolidationScheduler,
  createWakeScheduler,
  deleteKanaSession,
  getKanaSessionLogPath,
  KANA_BUILT_IN_TOOL_NAMES,
  listKanaSessions,
  loadKanaConfig,
  loadKanaMcpConfig,
  loadKanaMemory,
  loadKanaSession,
  loadKanaSkillActivations,
  loadKanaToolApprovals,
  loadKanaUsageSummary,
  recordKanaAgentRunAccounting,
  runFullMemoryConsolidation,
  saveEnabledGlobalSkillNames,
} from "@/kana";
import { createNoopLogger, createSessionLogManager } from "@/logging";
import type { Tool } from "@/tools";
import { KanaTuiApp } from "./app/app";
import type { MemoryCompactSummary } from "./app/memory-compact-controller";
import {
  formatMcpLifecycleStatus,
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
  const config = loadKanaConfig();
  const logManager = createSessionLogManager({ level: config.logging.level });
  const toolApprovals = loadKanaToolApprovals();
  const memoryConsolidationQueue = createMemoryConsolidationQueue();
  const wakeScheduler = createWakeScheduler();
  const memoryConsolidation = config.memory.enabled
    ? createMemoryConsolidationScheduler(config, { queue: memoryConsolidationQueue })
    : undefined;
  const createSession = (parentSessionPath?: string, title?: string) =>
    createKanaSession({
      title,
      model: {
        provider: config.model.provider,
        model: config.model.name,
      },
      parentSessionPath,
    });
  let session = options.showResumePicker
    ? undefined
    : options.resumeSessionId
      ? loadKanaSession(options.resumeSessionId)
      : {
          metadata: createSession(),
          messages: [],
        };
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
  }
  let resumeSessionId = options.resumeSessionId ? session?.metadata.id : undefined;
  let pendingForkMessages: Message[] | undefined;
  const mcpConfig = loadKanaMcpConfig();
  const enabledMcpServerCount = Object.values(mcpConfig.mcpServers).filter(
    (server) => server.enabled,
  ).length;
  const terminal = new ProcessTerminal(config.notification);
  let mcpTools: Tool[] = [];
  let updateMcpStartupStatus: ((status: string) => void) | undefined;
  let app: KanaTuiApp | undefined;
  const mcpManager = createKanaMcpManager(mcpConfig, {
    reservedToolNames: KANA_BUILT_IN_TOOL_NAMES,
    getLogger: () => sessionLogger,
    onProgress: (event) => {
      const status = formatMcpLifecycleStatus(event);
      if (status === undefined) {
        return;
      }

      if (event.operation === "start") {
        updateMcpStartupStatus?.(status);
      } else {
        app?.showShutdownStatus(status);
      }
    },
  });
  let removeProcessSignals = (): void => {};
  const closeMcpManager = async (): Promise<void> => {
    removeProcessSignals();
    await mcpManager.close();
  };
  const loadMcpTools = async (
    onProgress: (status: string) => void,
  ): Promise<{ status: string; warnings: string[] }> => {
    updateMcpStartupStatus = onProgress;
    try {
      mcpTools = await mcpManager.start();
      sessionLogger.info("mcp.started", {
        configuredServerCount: enabledMcpServerCount,
        readyServerCount: mcpManager.diagnostics.filter(
          (diagnostic) => diagnostic.status === "ready",
        ).length,
        toolCount: mcpTools.length,
      });
      return {
        status: formatMcpStartupSummary(mcpManager.diagnostics, mcpTools.length),
        warnings: formatMcpStartupWarnings(mcpManager.diagnostics),
      };
    } finally {
      updateMcpStartupStatus = undefined;
    }
  };

  app = await createTuiAppWithCleanup(
    closeMcpManager,
    (agentOptions) => {
      // Each Agent retains this concrete logger for its full lifetime. It must
      // never resolve the active session again after an asynchronous run starts.
      const agentLogger = sessionLogger;

      return createKanaAgent(config, {
        ...agentOptions,
        additionalTools: mcpTools,
        logger: agentLogger,
        wakeScheduler,
        sessionId: agentOptions.sessionId,
        messages: agentOptions.messages ?? session?.messages,
        onRunCommitted: ({ messages, state, event }) => {
          session ??= {
            metadata: createSession(),
            messages: [],
          };
          const messagesToPersist = pendingForkMessages
            ? [...pendingForkMessages, ...messages]
            : messages;

          try {
            appendKanaSessionMessages(session.metadata, messagesToPersist);
          } catch (error) {
            agentLogger.error("session.append_failed", { error });
            throw error;
          }
          session.messages = [...session.messages, ...messages];
          pendingForkMessages = undefined;

          if (messagesToPersist.length > 0) {
            resumeSessionId = session.metadata.id;
          }

          recordKanaAgentRunAccounting({
            sessionId: session.metadata.id,
            cwd: session.metadata.cwd,
            agentKind: "main",
            outcome: event.reason,
            messages,
            model: state.model.metadata,
          });

          // Keep consolidation off the completed conversation's critical path;
          // the shared queue serializes each scope's read-modify-write jobs.
          const memoryLogger = agentLogger;
          const accountingSession = { id: session.metadata.id, cwd: session.metadata.cwd };
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
      });
    },
    terminal,
    {
      sessionId: session?.metadata.id,
      initialMessages: session?.messages,
      initialPrompt: options.initialPrompt,
      getResumeSessionId: () => resumeSessionId,
      startInResumePicker: options.showResumePicker,
      createNewSession: () => {
        session = {
          metadata: createSession(),
          messages: [],
        };
        activateSessionLogger(session);
        sessionLogger.info("session.created");
        resumeSessionId = undefined;
        pendingForkMessages = undefined;

        return {
          id: session.metadata.id,
        };
      },
      forkSession: (messages, prompt) => {
        session ??= {
          metadata: createSession(),
          messages: [],
        };
        const source = session;

        session = {
          metadata: createSession(source.metadata.path, prompt),
          messages,
        };
        activateSessionLogger(session);
        sessionLogger.info("session.forked", { sourceSessionId: source.metadata.id });
        resumeSessionId = undefined;
        pendingForkMessages = messages;

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
        activateSessionLogger(session);
        sessionLogger.info("session.resumed");
        resumeSessionId = session.metadata.id;
        pendingForkMessages = undefined;

        return {
          id: session.metadata.id,
          messages: session.messages,
        };
      },
      deleteSession: (sessionId) => deleteKanaSession(sessionId, { cwd: process.cwd() }),
      loadSkills: () => loadKanaSkillActivations({ cwd: process.cwd() }),
      saveEnabledGlobalSkills: (names) => saveEnabledGlobalSkillNames(names),
      toolApproval: {
        config: config.approval,
        approvals: toolApprovals,
        resolveToolSource: (toolName) => {
          const source = mcpManager.getToolSource(toolName);

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
      ...(enabledMcpServerCount === 0 ? {} : { loadExternalTools: loadMcpTools }),
      onStop: closeMcpManager,
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
