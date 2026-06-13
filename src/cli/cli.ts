import { Command } from "commander";
import type { InstallKanaConfigResult } from "@/kana";
import type { StartTuiOptions } from "@/tui";

export type CreateCliOptions = {
  installKanaConfig: (
    env: NodeJS.ProcessEnv,
    options: { force?: boolean },
  ) => InstallKanaConfigResult;
  log?: (message: string) => void;
  startTui: (options?: StartTuiOptions) => void;
};

export function createCli(options: CreateCliOptions): Command {
  const installConfig = options.installKanaConfig;
  const log = options.log ?? console.log;
  const runTui = options.startTui;
  const program = new Command();

  program
    .name("kana")
    .description("Personal TypeScript/Bun agent runtime")
    .version("0.0.0")
    .argument("[prompt...]", "Prompt to send after opening the TUI")
    .action((promptParts: string[] = []) => {
      const prompt = promptParts.join(" ").trim();

      if (prompt) {
        runTui({ initialPrompt: prompt });
        return;
      }

      runTui();
    });

  program
    .command("resume")
    .description("Resume a saved agent session")
    .argument("[sessionId]", "Session id to resume")
    .action((sessionId: string | undefined) => {
      runTui({
        resumeSessionId: sessionId,
        showResumePicker: sessionId === undefined,
      });
    });

  program
    .command("install")
    .description("Create the default Kana files under ~/.kana")
    .option("--force", "Overwrite the existing Kana files")
    .action((options: { force?: boolean }) => {
      const result = installConfig(process.env, {
        force: options.force,
      });
      log(
        formatInstallMessage("config", result.configPath, result.configStatus),
      );
      log(
        formatInstallMessage(
          "approvals",
          result.approvalsPath,
          result.approvalsStatus,
        ),
      );
    });

  return program;
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

export async function runCli(
  argv: string[],
  options: CreateCliOptions,
): Promise<void> {
  try {
    await createCli(options).parseAsync(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
