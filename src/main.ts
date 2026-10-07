import { runCli } from "@/cli";
import { startHeadless } from "@/headless";
import {
  installKanaConfig,
  installKanaSkills,
  reinstallKanaSkills,
  resetKanaConfig,
  resyncKanaSkills,
  syncKanaSkills,
  updateKana,
} from "@/kana";
import { startServer } from "@/server";
import { startTui } from "@/tui";

await runCli(process.argv, {
  installKanaConfig,
  installKanaSkills,
  reinstallKanaSkills,
  resetKanaConfig,
  resyncKanaSkills,
  syncKanaSkills,
  startHeadless,
  startServer,
  startTui,
  updateKana,
});
