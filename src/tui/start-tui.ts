import {
  appendKanaSessionMessages,
  createKanaAgent,
  createKanaSession,
  listKanaSessions,
  loadKanaConfig,
  loadKanaSession,
} from "@/kana";
import type { Message } from "@/core";
import { KanaTuiApp } from "./app/app";
import { ProcessTerminal } from "./runtime";

export type StartTuiOptions = {
  resumeSessionId?: string;
  showResumePicker?: boolean;
};

export function startTui(options: StartTuiOptions = {}): void {
  const config = loadKanaConfig();
  const createSession = (parentSessionPath?: string) =>
    createKanaSession({
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
  let resumeSessionId = options.resumeSessionId ? session?.metadata.id : undefined;
  let pendingForkMessages: Message[] | undefined;

  const app = new KanaTuiApp(
    (agentOptions) =>
      createKanaAgent(config, {
        ...agentOptions,
        messages: session?.messages,
        onRunCommitted: ({ messages }) => {
          session ??= {
            metadata: createSession(),
            messages: [],
          };
          const messagesToPersist = pendingForkMessages
            ? [...pendingForkMessages, ...messages]
            : messages;

          appendKanaSessionMessages(session.metadata, messagesToPersist);
          session.messages = [...session.messages, ...messages];
          pendingForkMessages = undefined;

          if (messagesToPersist.length > 0) {
            resumeSessionId = session.metadata.id;
          }
        },
      }),
    new ProcessTerminal(),
    {
      sessionId: session?.metadata.id,
      initialMessages: session?.messages,
      getResumeSessionId: () => resumeSessionId,
      startInResumePicker: options.showResumePicker,
      createNewSession: () => {
        session = {
          metadata: createSession(),
          messages: [],
        };
        resumeSessionId = undefined;
        pendingForkMessages = undefined;

        return {
          id: session.metadata.id,
        };
      },
      forkSession: (messages) => {
        session ??= {
          metadata: createSession(),
          messages: [],
        };
        const source = session;

        session = {
          metadata: createSession(source.metadata.path),
          messages,
        };
        resumeSessionId = undefined;
        pendingForkMessages = messages;

        return {
          id: session.metadata.id,
        };
      },
      listSessions: () => listKanaSessions({ cwd: process.cwd() }),
      loadSession: (sessionId) => {
        session = loadKanaSession(sessionId, { cwd: process.cwd() });
        resumeSessionId = session.metadata.id;
        pendingForkMessages = undefined;

        return {
          id: session.metadata.id,
          messages: session.messages,
        };
      },
    },
  );

  app.start();
}
