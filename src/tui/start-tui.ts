import { createKanaAgent } from "../kana/agent";
import { KanaTuiApp } from "./app/app";
import { ProcessTerminal } from "./runtime/terminal";

export type StartTuiOptions = {
  apiKey?: string;
};

export function startTui(options: StartTuiOptions = {}): void {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing DEEPSEEK_API_KEY. Run with: DEEPSEEK_API_KEY=... ./kana",
    );
  }

  const app = new KanaTuiApp(createKanaAgent(apiKey), new ProcessTerminal());

  app.start();
}
