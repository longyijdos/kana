import { runCli } from "@/cli";
import { installKanaConfig } from "@/kana";
import { startTui } from "@/tui";

await runCli(process.argv, {
  installKanaConfig,
  startTui,
});
