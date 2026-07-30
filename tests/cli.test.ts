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

  test("waits for asynchronous TUI shutdown", async () => {
    const events: string[] = [];
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parsingFinished = false;
    const parsing = parse(["node", "kana"], {
      startTui: async () => {
        events.push("started");
        await stopped;
        events.push("stopped");
      },
    }).then(() => {
      parsingFinished = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["started"]);
    expect(parsingFinished).toBe(false);

    release();
    await parsing;

    expect(events).toEqual(["started", "stopped"]);
    expect(parsingFinished).toBe(true);
  });

  test("reports every installed config file", async () => {
    const logs: string[] = [];

    await parse(["node", "kana", "install"], {
      installKanaConfig: () => ({
        configPath: "/tmp/config.toml",
        configStatus: "defaults",
        configExamplePath: "/tmp/config.example.toml",
        configExampleStatus: "created",
        mcpConfigPath: "/tmp/mcp.json",
        mcpConfigStatus: "created",
        mcpEnabledPath: "/tmp/mcp-enabled.json",
        mcpEnabledStatus: "created",
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
      "Created config example: /tmp/config.example.toml",
      "Created MCP config: /tmp/mcp.json",
      "Created MCP activation state: /tmp/mcp-enabled.json",
      "Approvals already exists: /tmp/approvals.json",
      "Created skills config: /tmp/skills.toml",
    ]);
  });

  test("keeps installation and Skills repository commands separate", async () => {
    const calls: string[] = [];

    await parse(["node", "kana", "install"], {
      installKanaConfig: () => {
        calls.push("config");
        return defaultInstallResult();
      },
      installKanaSkills: async () => {
        calls.push("skills");
        return {
          skillsPath: "/tmp/.kana/skills/kana-skills",
          status: "cloned",
        };
      },
    });
    await parse(["node", "kana", "skills", "install"], {
      installKanaConfig: () => {
        calls.push("config");
        return defaultInstallResult();
      },
      installKanaSkills: async () => {
        calls.push("skills");
        return {
          skillsPath: "/tmp/.kana/skills/kana-skills",
          status: "updated",
        };
      },
    });

    expect(calls).toEqual(["config", "skills"]);
  });

  test("exposes semantic install commands without legacy force options", () => {
    const program = createCli(defaultCliOptions());
    const install = program.commands.find((command) => command.name() === "install");
    const skills = program.commands.find((command) => command.name() === "skills");

    expect(install?.options.map((option) => option.long)).toEqual([]);
    expect(skills?.commands.map((command) => command.name())).toEqual([
      "install",
      "reinstall",
      "sync",
      "resync",
    ]);
    for (const command of skills?.commands ?? []) {
      expect(command.options.map((option) => option.long)).not.toContain("--force");
    }
  });

  test("confirms reset with an explicit scope before changing configuration", async () => {
    const prompts: string[] = [];
    const logs: string[] = [];
    let resetCalls = 0;

    await parse(["node", "kana", "reset"], {
      confirm: async (message) => {
        prompts.push(message);
        return true;
      },
      isInteractive: () => true,
      log: (message) => {
        logs.push(message);
      },
      resetKanaConfig: () => {
        resetCalls += 1;
        return defaultResetResult();
      },
    });

    expect(resetCalls).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("delete config.toml");
    expect(prompts[0]).toContain("config.example.toml");
    expect(prompts[0]).toContain("mcp.json");
    expect(prompts[0]).toContain("mcp-enabled.json");
    expect(prompts[0]).toContain("approvals.json");
    expect(prompts[0]).toContain("skills/skills.toml");
    expect(prompts[0]).toContain("OAuth tokens");
    expect(prompts[0]).toContain("logs");
    expect(prompts[0]).toContain("installed Skills");
    expect(logs).toEqual([
      "Removed config override: /tmp/config.toml",
      "Reset config example: /tmp/config.example.toml",
      "Reset MCP config: /tmp/mcp.json",
      "Reset MCP activation state: /tmp/mcp-enabled.json",
      "Reset approvals: /tmp/approvals.json",
      "Reset skills config: /tmp/skills.toml",
    ]);
  });

  test("does not reset configuration when confirmation is declined", async () => {
    const logs: string[] = [];

    await parse(["node", "kana", "reset"], {
      confirm: async () => false,
      isInteractive: () => true,
      log: (message) => {
        logs.push(message);
      },
      resetKanaConfig: () => {
        throw new Error("reset should not run");
      },
    });

    expect(logs).toEqual(["Reset cancelled."]);
  });

  test("requires --yes for reset in non-interactive environments", async () => {
    let resetCalls = 0;
    const options: Partial<CreateCliOptions> = {
      confirm: async () => {
        throw new Error("confirmation should not run");
      },
      isInteractive: () => false,
      resetKanaConfig: () => {
        resetCalls += 1;
        return defaultResetResult();
      },
    };

    await expect(parse(["node", "kana", "reset"], options)).rejects.toThrow("kana reset --yes");
    expect(resetCalls).toBe(0);

    await parse(["node", "kana", "reset", "--yes"], options);
    expect(resetCalls).toBe(1);
  });

  test("manages OpenAI Codex authentication", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const options = {
      authorizeOpenAICodex: async () => {
        calls.push("login");
        return { accessToken: "access-token", accountId: "account-id" };
      },
      getOpenAICodexAuthStatus: async () => ({
        state: "authorized" as const,
        refreshable: true,
        expiresAt: 1_800_000,
      }),
      signOutOpenAICodex: async () => {
        calls.push("logout");
      },
      log: (message: string) => {
        logs.push(message);
      },
    };

    await parse(["node", "kana", "auth", "login", "openai-codex"], options);
    await parse(["node", "kana", "auth", "status", "openai-codex"], options);
    await parse(["node", "kana", "auth", "logout", "openai-codex"], options);

    expect(calls).toEqual(["login", "logout"]);
    expect(logs).toEqual([
      "Authorized openai-codex.",
      "openai-codex: authorized, refreshable, expires 1970-01-01T00:30:00.000Z",
      "Signed out from openai-codex.",
    ]);
  });

  test("rejects Kana-managed authentication for unsupported providers", async () => {
    expect(parse(["node", "kana", "auth", "login", "deepseek"], {})).rejects.toThrow(
      "Provider deepseek does not support Kana-managed authentication.",
    );
  });

  test("syncs skills to an agent preset without replacing existing Skills", async () => {
    const logs: string[] = [];
    const calls: Array<{ targetAgent?: string; targetDir?: string }> = [];

    await parse(["node", "kana", "skills", "sync", "codex"], {
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
              status: "exists",
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

    expect(calls).toEqual([{ targetAgent: "codex", targetDir: undefined }]);
    expect(logs).toEqual([
      "Synced skills to codex: /tmp/.codex/skills (copied 1, replaced 0, skipped 1)",
    ]);
  });

  test("syncs skills to a custom target directory", async () => {
    const calls: Array<{ targetAgent?: string; targetDir?: string }> = [];

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

    expect(calls).toEqual([{ targetAgent: undefined, targetDir: "/tmp/agent/skills" }]);
  });

  test("requires --yes before reinstalling Skills non-interactively", async () => {
    let reinstallCalls = 0;
    const options: Partial<CreateCliOptions> = {
      confirm: async () => {
        throw new Error("confirmation should not run");
      },
      isInteractive: () => false,
      reinstallKanaSkills: async () => {
        reinstallCalls += 1;
        return {
          skillsPath: "/tmp/.kana/skills/kana-skills",
          status: "reinstalled",
        };
      },
    };

    await expect(parse(["node", "kana", "skills", "reinstall"], options)).rejects.toThrow(
      "kana skills reinstall --yes",
    );
    expect(reinstallCalls).toBe(0);

    await parse(["node", "kana", "skills", "reinstall", "--yes"], options);
    expect(reinstallCalls).toBe(1);
  });

  test("confirms and resyncs matching Skills for a parsed target", async () => {
    const prompts: string[] = [];
    const calls: Array<{ targetAgent?: string; targetDir?: string }> = [];

    await parse(["node", "kana", "skills", "resync", "codex"], {
      confirm: async (message) => {
        prompts.push(message);
        return true;
      },
      isInteractive: () => true,
      resyncKanaSkills: (_env, options) => {
        calls.push(options);
        return {
          sourcePath: "/tmp/.kana/skills/kana-skills",
          targetName: "codex",
          targetPath: "/tmp/.codex/skills",
          skills: [],
        };
      },
    });

    expect(calls).toEqual([{ targetAgent: "codex", targetDir: undefined }]);
    expect(prompts[0]).toContain("deleted and copied again");
    expect(prompts[0]).toContain("stale Skills");
  });

  test("requires --yes before resyncing Skills non-interactively", async () => {
    let resyncCalls = 0;
    const options: Partial<CreateCliOptions> = {
      isInteractive: () => false,
      resyncKanaSkills: () => {
        resyncCalls += 1;
        return {
          sourcePath: "/tmp/.kana/skills/kana-skills",
          targetName: "custom",
          targetPath: "/tmp/agent/skills",
          skills: [],
        };
      },
    };

    await expect(
      parse(["node", "kana", "skills", "resync", "--target-dir", "/tmp/agent/skills"], options),
    ).rejects.toThrow("--yes");
    expect(resyncCalls).toBe(0);

    await parse(
      ["node", "kana", "skills", "resync", "--target-dir", "/tmp/agent/skills", "--yes"],
      options,
    );
    expect(resyncCalls).toBe(1);
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
    confirm: async () => true,
    installKanaConfig: defaultInstallResult,
    installKanaSkills: async () => ({
      skillsPath: "/tmp/.kana/skills/kana-skills",
      status: "cloned",
    }),
    isInteractive: () => true,
    reinstallKanaSkills: async () => ({
      skillsPath: "/tmp/.kana/skills/kana-skills",
      status: "reinstalled",
    }),
    resetKanaConfig: defaultResetResult,
    resyncKanaSkills: () => ({
      sourcePath: "/tmp/.kana/skills/kana-skills",
      targetName: "codex",
      targetPath: "/tmp/.codex/skills",
      skills: [],
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

function defaultInstallResult(): ReturnType<CreateCliOptions["installKanaConfig"]> {
  return {
    configPath: "/tmp/config.toml",
    configStatus: "defaults",
    configExamplePath: "/tmp/config.example.toml",
    configExampleStatus: "created",
    mcpConfigPath: "/tmp/mcp.json",
    mcpConfigStatus: "created",
    mcpEnabledPath: "/tmp/mcp-enabled.json",
    mcpEnabledStatus: "created",
    approvalsPath: "/tmp/approvals.json",
    approvalsStatus: "created",
    skillsConfigPath: "/tmp/skills.toml",
    skillsConfigStatus: "created",
  };
}

function defaultResetResult(): ReturnType<CreateCliOptions["resetKanaConfig"]> {
  return {
    configPath: "/tmp/config.toml",
    configRemoved: true,
    configExamplePath: "/tmp/config.example.toml",
    mcpConfigPath: "/tmp/mcp.json",
    mcpEnabledPath: "/tmp/mcp-enabled.json",
    approvalsPath: "/tmp/approvals.json",
    skillsConfigPath: "/tmp/skills.toml",
  };
}
