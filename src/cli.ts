import { Command } from "commander";
import { startTui } from "./tui/main";

export function createCli(): Command {
  const program = new Command();

  program
    .name("kana")
    .description("Personal TypeScript/Bun agent runtime")
    .version("0.0.0")
    .option("--api-key <key>", "DeepSeek API key. Defaults to DEEPSEEK_API_KEY.")
    .action((options: { apiKey?: string }) => {
      startTui({
        apiKey: options.apiKey,
      });
    });

  program
    .command("chat", { isDefault: false })
    .description("Start the interactive agent TUI")
    .option("--api-key <key>", "DeepSeek API key. Defaults to DEEPSEEK_API_KEY.")
    .action((options: { apiKey?: string }) => {
      startTui({
        apiKey: options.apiKey,
      });
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

await runCli();
