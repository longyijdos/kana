import { runCli } from "@/cli";
import {
  installKanaConfig,
  installKanaSkills,
  reinstallKanaSkills,
  resetKanaConfig,
  resyncKanaSkills,
  syncKanaSkills,
  updateKana,
} from "@/kana";
import { startTui } from "@/tui";

await runCli(process.argv, {
  installKanaConfig,
  installKanaSkills,
  reinstallKanaSkills,
  resetKanaConfig,
  resyncKanaSkills,
  syncKanaSkills,
  startTui,
  updateKana,
});
