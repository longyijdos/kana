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
    .description("Create the default Kana config under ~/.kana")
    .option("--force", "Overwrite the existing Kana config")
    .action((options: { force?: boolean }) => {
      const result = installConfig(process.env, {
        force: options.force,
      });
      log(
        result.status === "created"
          ? `Created config: ${result.configPath}`
          : result.status === "reinstalled"
            ? `Reinstalled config: ${result.configPath}`
            : `Config already exists: ${result.configPath}`,
      );
    });

  return program;
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
