import { Command } from "commander";
import type {
  InstallKanaConfigResult,
  InstallKanaSkillsResult,
  SyncKanaSkillsResult,
} from "@/kana";
import type { StartTuiOptions } from "@/tui";
import { KANA_VERSION } from "../version";

export type CreateCliOptions = {
  installKanaConfig: (
    env: NodeJS.ProcessEnv,
    options: { force?: boolean },
  ) => InstallKanaConfigResult;
  installKanaSkills: (
    env: NodeJS.ProcessEnv,
    options: { force?: boolean },
  ) => Promise<InstallKanaSkillsResult>;
  syncKanaSkills: (
    env: NodeJS.ProcessEnv,
    options: { force?: boolean; targetAgent?: string; targetDir?: string },
  ) => SyncKanaSkillsResult;
  log?: (message: string) => void;
  startTui: (options?: StartTuiOptions) => Promise<void> | void;
};

export function createCli(options: CreateCliOptions): Command {
  const installConfig = options.installKanaConfig;
  const installSkills = options.installKanaSkills;
  const log = options.log ?? console.log;
  const runTui = options.startTui;
  const syncSkills = options.syncKanaSkills;
  const program = new Command();

  program
    .name("kana")
    .description("Personal TypeScript/Bun agent runtime")
    .version(KANA_VERSION)
    .argument("[prompt...]", "Prompt to send after opening the TUI")
    .action(async (promptParts: string[] = []) => {
      const prompt = promptParts.join(" ").trim();

      if (prompt) {
        await runTui({ initialPrompt: prompt });
        return;
      }

      await runTui();
    });

  program
    .command("resume")
    .description("Resume a saved agent session")
    .argument("[sessionId]", "Session id to resume")
    .action(async (sessionId: string | undefined) => {
      await runTui({
        resumeSessionId: sessionId,
        showResumePicker: sessionId === undefined,
      });
    });

  program
    .command("install")
    .description("Create the default Kana files under ~/.kana")
    .option("--force", "Overwrite the existing Kana files")
    .option("--skills", "Install or update Kana skills from the default repository")
    .action(async (options: { force?: boolean; skills?: boolean }) => {
      const result = installConfig(process.env, {
        force: options.force,
      });
      log(formatInstallMessage("config", result.configPath, result.configStatus));
      log(formatInstallMessage("MCP config", result.mcpConfigPath, result.mcpConfigStatus));
      log(formatInstallMessage("approvals", result.approvalsPath, result.approvalsStatus));
      log(
        formatInstallMessage("skills config", result.skillsConfigPath, result.skillsConfigStatus),
      );

      if (options.skills) {
        const skillsResult = await installSkills(process.env, {
          force: options.force,
        });
        log(formatInstallSkillsMessage(skillsResult));
      }
    });

  const skillsCommand = program.command("skills").description("Manage Kana skills");

  skillsCommand
    .command("sync")
    .description("Copy installed Kana skills to another agent's skills directory")
    .argument("[target]", "Target agent preset, such as codex")
    .option("--target-dir <path>", "Copy to a custom skills directory")
    .option("--force", "Replace existing target skill directories")
    .action(
      (
        targetAgent: string | undefined,
        commandOptions: { force?: boolean; targetDir?: string },
      ) => {
        const result = syncSkills(process.env, {
          force: commandOptions.force,
          targetAgent,
          targetDir: commandOptions.targetDir,
        });

        log(formatSyncKanaSkillsMessage(result));
      },
    );

  return program;
}

function formatInstallSkillsMessage(result: InstallKanaSkillsResult): string {
  switch (result.status) {
    case "cloned":
      return `Installed skills: ${result.skillsPath}`;
    case "updated":
      return `Updated skills: ${result.skillsPath}`;
    case "reinstalled":
      return `Reinstalled skills: ${result.skillsPath}`;
  }
}

function formatSyncKanaSkillsMessage(result: SyncKanaSkillsResult): string {
  const counts = result.skills.reduce(
    (summary, skill) => {
      summary[skill.status] += 1;
      return summary;
    },
    {
      copied: 0,
      exists: 0,
      replaced: 0,
    },
  );
  const parts = [
    `copied ${counts.copied}`,
    `replaced ${counts.replaced}`,
    `skipped ${counts.exists}`,
  ];
  const targetLabel = result.targetName === "custom" ? "custom target" : result.targetName;

  return `Synced skills to ${targetLabel}: ${result.targetPath} (${parts.join(", ")})`;
}

function formatInstallMessage(
  name: string,
  filePath: string,
  status: "created" | "exists" | "reinstalled",
): string {
  switch (status) {
    case "created":
      return `Created ${name}: ${filePath}`;
    case "reinstalled":
      return `Reinstalled ${name}: ${filePath}`;
    case "exists":
      return `${capitalize(name)} already exists: ${filePath}`;
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export async function runCli(argv: string[], options: CreateCliOptions): Promise<void> {
  try {
    await createCli(options).parseAsync(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
