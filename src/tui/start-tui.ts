import {
  addModelUsage,
  calculateUsageCostCny,
  type Message,
  type ModelMetadata,
  type ModelUsage,
} from "@/core";
import {
  appendKanaRunAccounting,
  appendKanaSessionMessages,
  createKanaAgent,
  createKanaSession,
  createMemoryConsolidationQueue,
  createMemoryConsolidationScheduler,
  deleteKanaSession,
  getKanaSessionLogPath,
  listKanaSessions,
  loadKanaConfig,
  loadKanaMemory,
  loadKanaSession,
  loadKanaSkillActivations,
  loadKanaToolApprovals,
  loadKanaUsageSummary,
  runFullMemoryConsolidation,
  saveEnabledGlobalSkillNames,
} from "@/kana";
import { createNoopLogger, createSessionLogManager } from "@/logging";
import { KanaTuiApp } from "./app/app";
import type { MemoryCompactSummary } from "./app/memory-compact-controller";
import { ProcessTerminal } from "./runtime";

export type StartTuiOptions = {
  initialPrompt?: string;
  resumeSessionId?: string;
  showResumePicker?: boolean;
};

export function startTui(options: StartTuiOptions = {}): void {
  const config = loadKanaConfig();
  const logManager = createSessionLogManager({ level: config.logging.level });
  const toolApprovals = loadKanaToolApprovals();
  const memoryConsolidationQueue = createMemoryConsolidationQueue();
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

  const app = new KanaTuiApp(
    (agentOptions) => {
      // Each Agent retains this concrete logger for its full lifetime. It must
      // never resolve the active session again after an asynchronous run starts.
      const agentLogger = sessionLogger;

      return createKanaAgent(config, {
        ...agentOptions,
        logger: agentLogger,
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

          appendUsageRecord(
            session.metadata.id,
            session.metadata.cwd,
            "main",
            event.reason,
            messages,
            state.model.metadata,
          );

          // Keep consolidation off the completed conversation's critical path;
          // the shared queue serializes each scope's read-modify-write jobs.
          const memoryLogger = agentLogger;
          const accountingSession = { id: session.metadata.id, cwd: session.metadata.cwd };
          void memoryConsolidation
            ?.schedule(messages, {
              logger: memoryLogger,
              onCompleted: (scope, result) =>
                appendUsageRecord(
                  accountingSession.id,
                  accountingSession.cwd,
                  "memory_consolidation",
                  result.outcome,
                  result.state.messages,
                  result.state.model.metadata,
                  { scope, mode: "incremental", origin: "automatic" },
                ),
            })
            .catch((error) => {
              memoryLogger.error("memory_consolidation.failed", { error });
            });
        },
      });
    },
    new ProcessTerminal(config.notification),
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
      },
      notification: config.notification,
      getLogger: () => sessionLogger,
      compactMemory: async (target, userRequest, signal) => {
        const memoryLogger = sessionLogger;
        const scopes: Array<"global" | "project"> =
          target === "user"
            ? ["global"]
            : target === "workspace"
              ? ["project"]
              : ["global", "project"];

        return Promise.all(
          scopes.map(async (scope): Promise<MemoryCompactSummary> => {
            const targetName = scope === "global" ? "user" : "workspace";
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
                appendUsageRecord(
                  session.metadata.id,
                  session.metadata.cwd,
                  "memory_consolidation",
                  result.outcome,
                  result.state.messages,
                  result.state.model.metadata,
                  { scope, mode: "full", origin: "manual" },
                );
              }
              return { target: targetName, outcome: result.outcome };
            } catch (error) {
              return {
                target: targetName,
                outcome: "error",
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
      },
      loadMemory: (target) =>
        loadKanaMemory(target === "user" ? "global" : "project", { cwd: process.cwd() }),
      loadUsage: (scope) =>
        loadKanaUsageSummary({
          scope,
          sessionId: scope === "session" ? session?.metadata.id : undefined,
          cwd: process.cwd(),
        }),
    },
  );

  app.start();
}

function appendUsageRecord(
  sessionId: string,
  cwd: string,
  agentKind: "main" | "memory_consolidation",
  outcome: "stop" | "length" | "aborted" | "error" | "updated" | "unchanged",
  messages: Message[],
  model: ModelMetadata,
  memory?: {
    scope: "global" | "project";
    mode: "incremental" | "full";
    origin: "automatic" | "manual";
  },
): void {
  const usage = sumUsage(messages);
  appendKanaRunAccounting(
    {
      sessionId,
      agentKind,
      outcome,
      model: { provider: model.provider, model: model.model },
      pricing: model.cost,
      usage,
      costCny: usage ? calculateUsageCostCny(usage, model.cost) : 0,
      assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
      ...(memory
        ? { memoryScope: memory.scope, memoryMode: memory.mode, memoryOrigin: memory.origin }
        : {}),
    },
    { cwd },
  );
}

function sumUsage(messages: Message[]): ModelUsage | undefined {
  return messages.reduce<ModelUsage | undefined>(
    (total, message) =>
      message.role === "assistant" && message.usage ? addModelUsage(total, message.usage) : total,
    undefined,
  );
}
