import { describe, expect, test } from "bun:test";
import { type CreateCliOptions, createCli } from "../src/cli";
import type { StartTuiOptions } from "../src/tui";
import { KANA_VERSION } from "../src/version";

describe("CLI", () => {
  test("uses the shared application version", () => {
    expect(createCli(defaultCliOptions()).version()).toBe(KANA_VERSION);
  });

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

  test("reports installed config and approvals", async () => {
    const logs: string[] = [];

    await parse(["node", "kana", "install"], {
      installKanaConfig: () => ({
        configPath: "/tmp/config.toml",
        configStatus: "created",
        approvalsPath: "/tmp/approvals.json",
        approvalsStatus: "exists",
        skillsConfigPath: "/tmp/skills.toml",
        skillsConfigStatus: "created",
      }),
      log: (message) => {
        logs.push(message);
      },
    });

    expect(logs).toEqual([
      "Created config: /tmp/config.toml",
      "Approvals already exists: /tmp/approvals.json",
      "Created skills config: /tmp/skills.toml",
    ]);
  });

  test("installs skills when requested", async () => {
    const logs: string[] = [];
    const calls: Array<{ force?: boolean }> = [];

    await parse(["node", "kana", "install", "--skills", "--force"], {
      installKanaSkills: async (_env, options) => {
        calls.push(options);
        return {
          skillsPath: "/tmp/.kana/skills/kana-skills",
          status: "reinstalled",
        };
      },
      log: (message) => {
        logs.push(message);
      },
    });

    expect(calls).toEqual([{ force: true }]);
    expect(logs).toEqual([
      "Created config: /tmp/config.toml",
      "Created approvals: /tmp/approvals.json",
      "Created skills config: /tmp/skills.toml",
      "Reinstalled skills: /tmp/.kana/skills/kana-skills",
    ]);
  });
});

async function parse(argv: string[], options: Partial<CreateCliOptions>): Promise<void> {
  await createCli({
    ...defaultCliOptions(),
    ...options,
  }).parseAsync(argv);
}

function defaultCliOptions(): CreateCliOptions {
  return {
    installKanaConfig: () => ({
      configPath: "/tmp/config.toml",
      configStatus: "created",
      approvalsPath: "/tmp/approvals.json",
      approvalsStatus: "created",
      skillsConfigPath: "/tmp/skills.toml",
      skillsConfigStatus: "created",
    }),
    installKanaSkills: async () => ({
      skillsPath: "/tmp/.kana/skills/kana-skills",
      status: "cloned",
    }),
    log: () => {},
    startTui: () => {},
  };
}
