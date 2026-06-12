import {
  appendKanaSessionMessages,
  createKanaAgent,
  createKanaSession,
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
  const session = options.resumeSessionId
    ? loadKanaSession(options.resumeSessionId)
    : {
        metadata: createKanaSession({
          model: {
            provider: config.model.provider,
            model: config.model.name,
          },
        }),
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
    },
  );

  app.start();
}
