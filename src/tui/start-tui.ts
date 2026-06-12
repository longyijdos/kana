import {
  appendKanaSessionMessages,
  createKanaAgent,
  createKanaSession,
  forkKanaSession,
  loadKanaConfig,
  loadKanaSession,
} from "@/kana";
import { KanaTuiApp } from "./app/app";
import { ProcessTerminal } from "./runtime";

export type StartTuiOptions = {
  resumeSessionId?: string;
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
  let session = options.resumeSessionId
    ? loadKanaSession(options.resumeSessionId)
    : {
        metadata: createSession(),
        messages: [],
      };

  const app = new KanaTuiApp(
    (agentOptions) =>
      createKanaAgent(config, {
        ...agentOptions,
        messages: session.messages,
        onRunCommitted: ({ messages }) => {
          appendKanaSessionMessages(session.metadata, messages);
        },
      }),
    new ProcessTerminal(),
    {
      sessionId: session.metadata.id,
      initialMessages: session.messages,
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
        session = {
          metadata: forkKanaSession(session.metadata, messages),
          messages,
        };
        return {
          id: session.metadata.id,
        };
      },
    },
  );

  app.start();
}
