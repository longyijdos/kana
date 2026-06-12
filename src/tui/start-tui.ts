import {
  appendKanaSessionMessages,
  createKanaAgent,
  createKanaSession,
  forkKanaSession,
  listKanaSessions,
  loadKanaConfig,
  loadKanaSession,
} from "@/kana";
import { KanaTuiApp } from "./app/app";
import { ProcessTerminal } from "./runtime";

export type StartTuiOptions = {
  resumeSessionId?: string;
  showResumePicker?: boolean;
};

export function startTui(options: StartTuiOptions = {}): void {
  const config = loadKanaConfig();
  const createSession = () =>
    createKanaSession({
      model: {
        provider: config.model.provider,
        model: config.model.name,
      },
    });
  let session = options.showResumePicker
    ? undefined
    : options.resumeSessionId
      ? loadKanaSession(options.resumeSessionId)
      : {
          metadata: createSession(),
          messages: [],
        };

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
          appendKanaSessionMessages(session.metadata, messages);
        },
      }),
    new ProcessTerminal(),
    {
      sessionId: session?.metadata.id,
      initialMessages: session?.messages,
      startInResumePicker: options.showResumePicker,
      createNewSession: () => {
        session = {
          metadata: createSession(),
          messages: [],
        };
        return {
          id: session.metadata.id,
        };
      },
      forkSession: (messages) => {
        session ??= {
          metadata: createSession(),
          messages: [],
        };
        session = {
          metadata: forkKanaSession(session.metadata, messages),
          messages,
        };
        return {
          id: session.metadata.id,
        };
      },
      listSessions: () => listKanaSessions({ cwd: process.cwd() }),
      loadSession: (sessionId) => {
        session = loadKanaSession(sessionId, { cwd: process.cwd() });

        return {
          id: session.metadata.id,
          messages: session.messages,
        };
      },
    },
  );

  app.start();
}
