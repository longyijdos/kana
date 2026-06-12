import { describe, expect, test } from "bun:test";
import { createCli, type CreateCliOptions } from "../src/cli";
import type { StartTuiOptions } from "../src/tui";

describe("CLI", () => {
  test("starts the TUI without an initial prompt by default", async () => {
    const calls: Array<StartTuiOptions | undefined> = [];

    await parse(["node", "kana"], {
      startTui: (options) => {
        calls.push(options);
      },
    });

    expect(calls).toEqual([undefined]);
  });

  test("passes root arguments as an initial TUI prompt", async () => {
    const calls: Array<StartTuiOptions | undefined> = [];

    await parse(["node", "kana", "explain", "this", "repo"], {
      startTui: (options) => {
        calls.push(options);
      },
    });

    expect(calls).toEqual([
      {
        initialPrompt: "explain this repo",
      },
    ]);
  });

  test("keeps resume as a subcommand", async () => {
    const calls: Array<StartTuiOptions | undefined> = [];

    await parse(["node", "kana", "resume", "session-1"], {
      startTui: (options) => {
        calls.push(options);
      },
    });

    expect(calls).toEqual([
      {
        resumeSessionId: "session-1",
        showResumePicker: false,
      },
    ]);
  });
});

async function parse(
  argv: string[],
  options: Partial<CreateCliOptions>,
): Promise<void> {
  const defaults: CreateCliOptions = {
    installKanaConfig: () => ({
      status: "created",
      configPath: "/tmp/config.toml",
    }),
    log: () => {},
    startTui: () => {},
  };

  await createCli({
    ...defaults,
    ...options,
  }).parseAsync(argv);
}
