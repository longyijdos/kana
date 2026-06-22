import type { Message } from "@/core";
import {
  appendKanaSessionMessages,
  createKanaAgent,
  createKanaSession,
  createMemoryConsolidationScheduler,
  deleteKanaSession,
  getKanaSessionLogPath,
  listKanaSessions,
  loadKanaConfig,
  loadKanaMemory,
  loadKanaSession,
  loadKanaSkillActivations,
  loadKanaToolApprovals,
  runFullMemoryConsolidation,
  saveEnabledGlobalSkillNames,
} from "@/kana";
import { createLoggerRouter, createNoopLogger, createSessionLogger } from "@/logging";
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
  const logRouter = createLoggerRouter();
  const toolApprovals = loadKanaToolApprovals();
  const memoryConsolidation = config.memory.enabled
    ? createMemoryConsolidationScheduler(config, { logger: logRouter.logger })
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
  const activateSessionLogger = (nextSession: typeof session): void => {
    logRouter.setLogger(
      nextSession
        ? createSessionLogger({
            path: getKanaSessionLogPath(nextSession.metadata.id, { cwd: nextSession.metadata.cwd }),
            sessionId: nextSession.metadata.id,
            level: config.logging.level,
          })
        : createNoopLogger(),
    );
  };
  activateSessionLogger(session);
  if (session) {
    logRouter.logger.info("session.started", { resumed: options.resumeSessionId !== undefined });
  }
  let resumeSessionId = options.resumeSessionId ? session?.metadata.id : undefined;
  let pendingForkMessages: Message[] | undefined;

  const app = new KanaTuiApp(
    (agentOptions) =>
      createKanaAgent(config, {
        ...agentOptions,
        logger: logRouter.logger,
        messages: agentOptions.messages ?? session?.messages,
        onRunCommitted: ({ messages }) => {
          session ??= {
            metadata: createSession(),
            messages: [],
          };
          activateSessionLogger(session);
          const messagesToPersist = pendingForkMessages
            ? [...pendingForkMessages, ...messages]
            : messages;

          try {
            appendKanaSessionMessages(session.metadata, messagesToPersist);
          } catch (error) {
            logRouter.logger.error("session.append_failed", { error });
            throw error;
          }
          session.messages = [...session.messages, ...messages];
          pendingForkMessages = undefined;

          if (messagesToPersist.length > 0) {
            resumeSessionId = session.metadata.id;
          }

          // Keep consolidation off the completed conversation's critical path;
          // the scheduler serializes each scope's read-modify-write jobs.
          void memoryConsolidation?.schedule(messages).catch((error) => {
            logRouter.logger.error("memory_consolidation.failed", { error });
          });
        },
      }),
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
        logRouter.logger.info("session.created");
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
        logRouter.logger.info("session.forked", { sourceSessionId: source.metadata.id });
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
        logRouter.logger.info("session.resumed");
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
      logger: logRouter.logger,
      compactMemory: async (target, userRequest, signal) => {
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
              const result = await runFullMemoryConsolidation(config, {
                scope,
                cwd: process.cwd(),
                userRequest,
                signal,
                logger: logRouter.logger,
              });
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
    },
  );

  app.start();
}
