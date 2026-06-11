import { createKanaAgent, loadKanaConfig } from "@/kana";
import { KanaTuiApp } from "./app/app";
import { ProcessTerminal } from "./runtime";

export function startTui(): void {
  const config = loadKanaConfig();

  const app = new KanaTuiApp(
    (agentOptions) => createKanaAgent(config, agentOptions),
    new ProcessTerminal(),
  );

  app.start();
}
