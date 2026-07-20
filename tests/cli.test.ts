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

  test("reports every installed config file", async () => {
    const logs: string[] = [];

    await parse(["node", "kana", "install"], {
      installKanaConfig: () => ({
        configPath: "/tmp/config.toml",
        configStatus: "created",
        mcpConfigPath: "/tmp/mcp.json",
        mcpConfigStatus: "created",
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
      "Created MCP config: /tmp/mcp.json",
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
      "Created MCP config: /tmp/mcp.json",
      "Created approvals: /tmp/approvals.json",
      "Created skills config: /tmp/skills.toml",
      "Reinstalled skills: /tmp/.kana/skills/kana-skills",
    ]);
  });

  test("syncs skills to an agent preset", async () => {
    const logs: string[] = [];
    const calls: Array<{ force?: boolean; targetAgent?: string; targetDir?: string }> = [];

    await parse(["node", "kana", "skills", "sync", "codex", "--force"], {
      syncKanaSkills: (_env, options) => {
        calls.push(options);
        return {
          sourcePath: "/tmp/.kana/skills/kana-skills",
          targetName: "codex",
          targetPath: "/tmp/.codex/skills",
          skills: [
            {
              name: "web-search",
              sourcePath: "/tmp/.kana/skills/kana-skills/web-search",
              status: "replaced",
              targetPath: "/tmp/.codex/skills/web-search",
            },
            {
              name: "web-fetch",
              sourcePath: "/tmp/.kana/skills/kana-skills/web-fetch",
              status: "copied",
              targetPath: "/tmp/.codex/skills/web-fetch",
            },
          ],
        };
      },
      log: (message) => {
        logs.push(message);
      },
    });

    expect(calls).toEqual([{ force: true, targetAgent: "codex", targetDir: undefined }]);
    expect(logs).toEqual([
      "Synced skills to codex: /tmp/.codex/skills (copied 1, replaced 1, skipped 0)",
    ]);
  });

  test("syncs skills to a custom target directory", async () => {
    const calls: Array<{ force?: boolean; targetAgent?: string; targetDir?: string }> = [];

    await parse(["node", "kana", "skills", "sync", "--target-dir", "/tmp/agent/skills"], {
      syncKanaSkills: (_env, options) => {
        calls.push(options);
        return {
          sourcePath: "/tmp/.kana/skills/kana-skills",
          targetName: "custom",
          targetPath: "/tmp/agent/skills",
          skills: [],
        };
      },
    });

    expect(calls).toEqual([
      { force: undefined, targetAgent: undefined, targetDir: "/tmp/agent/skills" },
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
      mcpConfigPath: "/tmp/mcp.json",
      mcpConfigStatus: "created",
      approvalsPath: "/tmp/approvals.json",
      approvalsStatus: "created",
      skillsConfigPath: "/tmp/skills.toml",
      skillsConfigStatus: "created",
    }),
    installKanaSkills: async () => ({
      skillsPath: "/tmp/.kana/skills/kana-skills",
      status: "cloned",
    }),
    syncKanaSkills: () => ({
      sourcePath: "/tmp/.kana/skills/kana-skills",
      targetName: "codex",
      targetPath: "/tmp/.codex/skills",
      skills: [],
    }),
    log: () => {},
    startTui: () => {},
  };
}
