import { runCli } from "@/cli";
import { installKanaConfig, installKanaSkills, syncKanaSkills } from "@/kana";
import { startTui } from "@/tui";

await runCli(process.argv, {
  installKanaConfig,
  installKanaSkills,
  syncKanaSkills,
  startTui,
});
