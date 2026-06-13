import { runCli } from "@/cli";
import { installKanaConfig, installKanaSkills } from "@/kana";
import { startTui } from "@/tui";

await runCli(process.argv, {
  installKanaConfig,
  installKanaSkills,
  startTui,
});
