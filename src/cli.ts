import { Command } from "commander";
import { installKanaConfig } from "./kana";
import { startTui } from "./tui";

export function createCli(): Command {
  const program = new Command();

  program
    .name("kana")
    .description("Personal TypeScript/Bun agent runtime")
    .version("0.0.0")
    .action(() => {
      startTui();
    });

  program
    .command("chat", { isDefault: false })
    .description("Start the interactive agent TUI")
    .action(() => {
      startTui();
    });

  program
    .command("install")
    .description("Create the default Kana config under ~/.kana")
    .option("--force", "Overwrite the existing Kana config")
    .action((options: { force?: boolean }) => {
      const result = installKanaConfig(process.env, {
        force: options.force,
      });
      console.log(
        result.status === "created"
          ? `Created config: ${result.configPath}`
          : result.status === "reinstalled"
            ? `Reinstalled config: ${result.configPath}`
          : `Config already exists: ${result.configPath}`,
      );
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  try {
    await createCli().parseAsync(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runCli();
}
