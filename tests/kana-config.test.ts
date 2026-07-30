import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildKanaSystemPrompt,
  createKanaAgent,
  DEFAULT_KANA_CONFIG,
  DEFAULT_KANA_TOOL_APPROVALS,
  formatKanaEnvironmentContext,
  getKanaConfigPaths,
  installKanaConfig,
  loadKanaConfig,
  loadKanaEnvironment,
  saveKanaMemory,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana config", () => {
  test("loads KANA_HOME/.env with priority over the existing environment", () => {
    const kanaHome = createTempDir();
    const env = createTempEnv({
      KANA_HOME: kanaHome,
      DEEPSEEK_API_KEY: "from-shell",
    });
    writeFileSync(
      path.join(kanaHome, ".env"),
      ['DEEPSEEK_API_KEY="from-kana-home"', "KANA_ENV_ONLY=available", ""].join("\n"),
    );

    loadKanaEnvironment(env);

    expect(env.DEEPSEEK_API_KEY).toBe("from-kana-home");
    expect(env.KANA_ENV_ONLY).toBe("available");
  });

  test("leaves the environment unchanged when KANA_HOME/.env is missing", () => {
    const env = createTempEnv({ DEEPSEEK_API_KEY: "from-shell" });

    loadKanaEnvironment(env);

    expect(env.DEEPSEEK_API_KEY).toBe("from-shell");
  });

  test("uses ~/.kana/config.toml by default", () => {
    expect(getKanaConfigPaths({ HOME: "/home/kana" })).toEqual({
      home: "/home/kana/.kana",
      configPath: "/home/kana/.kana/config.toml",
      configExamplePath: "/home/kana/.kana/config.example.toml",
      mcpConfigPath: "/home/kana/.kana/mcp.json",
      mcpEnabledPath: "/home/kana/.kana/mcp-enabled.json",
      agentsPath: "/home/kana/.kana/AGENTS.md",
      memoryDirectory: "/home/kana/.kana/memory",
      sessionsPath: "/home/kana/.kana/sessions",
      logsPath: "/home/kana/.kana/logs",
      accountingPath: "/home/kana/.kana/accounting",
      approvalsPath: "/home/kana/.kana/approvals.json",
      skillsConfigPath: "/home/kana/.kana/skills/skills.toml",
    });
  });

  test("installs state files without materializing the default config", () => {
    const env = createTempEnv();
    const firstInstall = installKanaConfig(env);
    const installedMcpConfig = JSON.parse(readFileSync(firstInstall.mcpConfigPath, "utf8"));
    const installedMcpEnabled = JSON.parse(readFileSync(firstInstall.mcpEnabledPath, "utf8"));
    const installedApprovals = JSON.parse(readFileSync(firstInstall.approvalsPath, "utf8"));
    const installedSkillsConfig = readFileSync(firstInstall.skillsConfigPath, "utf8");
    const installedConfigExample = readFileSync(firstInstall.configExamplePath, "utf8");

    expect(firstInstall.configStatus).toBe("defaults");
    expect(firstInstall.configExampleStatus).toBe("created");
    expect(firstInstall.mcpConfigStatus).toBe("created");
    expect(firstInstall.mcpEnabledStatus).toBe("created");
    expect(firstInstall.approvalsStatus).toBe("created");
    expect(firstInstall.skillsConfigStatus).toBe("created");
    expect(fileExists(firstInstall.configPath)).toBe(false);
    expect(installedConfigExample).toContain("[model.deepseek]");
    expect(installedConfigExample).toContain("[model.openai-codex]");
    expect(installedConfigExample).toContain("Kana does not read this file.");
    expect(installedMcpConfig).toEqual({ mcpServers: {} });
    expect(installedMcpEnabled).toEqual({ enabledServers: [] });
    expect(statSync(firstInstall.mcpEnabledPath).mode & 0o777).toBe(0o600);
    expect(installedApprovals).toEqual(DEFAULT_KANA_TOOL_APPROVALS);
    expect(installedSkillsConfig).toBe(["[model_invocation]", "enabled = []", ""].join("\n"));
    expect(fileExists(getKanaConfigPaths(env).agentsPath)).toBe(false);

    writeFileSync(firstInstall.configPath, "custom = true\n");
    writeFileSync(firstInstall.mcpConfigPath, '{"custom":true}\n');
    writeFileSync(firstInstall.mcpEnabledPath, '{"enabledServers":["custom"]}\n');
    writeFileSync(firstInstall.approvalsPath, '{"custom":true}\n');
    writeFileSync(firstInstall.skillsConfigPath, "custom = true\n");
    const secondInstall = installKanaConfig(env);

    expect(secondInstall).toEqual({
      configPath: firstInstall.configPath,
      configStatus: "exists",
      configExamplePath: firstInstall.configExamplePath,
      configExampleStatus: "exists",
      mcpConfigPath: firstInstall.mcpConfigPath,
      mcpConfigStatus: "exists",
      mcpEnabledPath: firstInstall.mcpEnabledPath,
      mcpEnabledStatus: "exists",
      approvalsPath: firstInstall.approvalsPath,
      approvalsStatus: "exists",
      skillsConfigPath: firstInstall.skillsConfigPath,
      skillsConfigStatus: "exists",
    });
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe("custom = true\n");
    expect(readFileSync(firstInstall.mcpConfigPath, "utf8")).toBe('{"custom":true}\n');
    expect(readFileSync(firstInstall.mcpEnabledPath, "utf8")).toBe(
      '{"enabledServers":["custom"]}\n',
    );
    expect(readFileSync(firstInstall.approvalsPath, "utf8")).toBe('{"custom":true}\n');
    expect(readFileSync(firstInstall.skillsConfigPath, "utf8")).toBe("custom = true\n");
  });

  test("force installs all default config files over existing files", () => {
    const env = createTempEnv();
    const { configPath, mcpConfigPath, mcpEnabledPath, approvalsPath, skillsConfigPath } =
      installKanaConfig(env);
    writeFileSync(configPath, "custom = true\n");
    writeFileSync(mcpConfigPath, '{"custom":true}\n');
    writeFileSync(mcpEnabledPath, '{"enabledServers":["custom"]}\n');
    writeFileSync(approvalsPath, '{"custom":true}\n');
    writeFileSync(skillsConfigPath, "custom = true\n");

    const result = installKanaConfig(env, { force: true });

    expect(result).toEqual({
      configPath,
      configStatus: "reinstalled",
      configExamplePath: path.join(path.dirname(configPath), "config.example.toml"),
      configExampleStatus: "exists",
      mcpConfigPath,
      mcpConfigStatus: "reinstalled",
      mcpEnabledPath,
      mcpEnabledStatus: "reinstalled",
      approvalsPath,
      approvalsStatus: "reinstalled",
      skillsConfigPath,
      skillsConfigStatus: "reinstalled",
    });
    expect(readFileSync(configPath, "utf8")).toContain('api_key_env = "DEEPSEEK_API_KEY"');
    expect(JSON.parse(readFileSync(mcpConfigPath, "utf8"))).toEqual({ mcpServers: {} });
    expect(JSON.parse(readFileSync(mcpEnabledPath, "utf8"))).toEqual({ enabledServers: [] });
    expect(JSON.parse(readFileSync(approvalsPath, "utf8"))).toEqual(DEFAULT_KANA_TOOL_APPROVALS);
    expect(readFileSync(skillsConfigPath, "utf8")).toBe(
      ["[model_invocation]", "enabled = []", ""].join("\n"),
    );
  });

  test("refreshes the generated config example without creating config.toml", () => {
    const env = createTempEnv();
    const firstInstall = installKanaConfig(env);
    writeFileSync(firstInstall.configExamplePath, "custom example\n");

    const secondInstall = installKanaConfig(env);

    expect(secondInstall.configStatus).toBe("defaults");
    expect(secondInstall.configExampleStatus).toBe("updated");
    expect(fileExists(secondInstall.configPath)).toBe(false);
    expect(readFileSync(secondInstall.configExamplePath, "utf8")).toContain("[model.openai-codex]");
  });

  test("loads defaults when config.toml is missing", () => {
    expect(loadKanaConfig(createTempEnv())).toEqual(DEFAULT_KANA_CONFIG);
  });

  test("merges TOML config with defaults", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[model]",
        'name = "deepseek-v4-flash"',
        'api_key_env = "KANA_DEEPSEEK_KEY"',
        "max_tokens = 4096",
        "",
        "[agent]",
        "max_turns = 4",
        "context_limit = 200000",
        "",
        "[approval]",
        'mode = "unless_trusted"',
        "",
        "[notification]",
        'backend = "bell"',
        "on_agent_completed = false",
        "on_approval_required = true",
        "",
        "[memory]",
        "enabled = false",
        "max_chars = 8000",
        "daily_retention_days = 14",
        "",
        "[logging]",
        'level = "debug"',
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env)).toEqual({
      ...DEFAULT_KANA_CONFIG,
      model: {
        ...DEFAULT_KANA_CONFIG.model,
        deepseek: {
          ...DEFAULT_KANA_CONFIG.model.deepseek,
          name: "deepseek-v4-flash",
          apiKeyEnv: "KANA_DEEPSEEK_KEY",
          maxTokens: 4096,
        },
      },
      agent: {
        maxTurns: 4,
        contextLimit: 200000,
      },
      approval: {
        mode: "unless_trusted",
      },
      notification: {
        backend: "bell",
        onAgentCompleted: false,
        onApprovalRequired: true,
      },
      memory: {
        enabled: false,
        maxChars: 8000,
        dailyRetentionDays: 14,
      },
      logging: {
        level: "debug",
      },
    });
  });

  test("loads provider-specific OpenAI Codex configuration", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[provider]",
        'active = "openai-codex"',
        "",
        "[model.openai-codex]",
        'name = "gpt-5.6-luna"',
        'reasoning_effort = "high"',
        'reasoning_summary = "concise"',
        "max_tokens = 16384",
        "timeout_ms = 90000",
        "max_retries = 2",
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env)).toEqual({
      ...DEFAULT_KANA_CONFIG,
      provider: {
        active: "openai-codex",
      },
      model: {
        ...DEFAULT_KANA_CONFIG.model,
        "openai-codex": {
          name: "gpt-5.6-luna",
          reasoningEffort: "high",
          reasoningSummary: "concise",
          maxTokens: 16_384,
          timeoutMs: 90_000,
          maxRetries: 2,
        },
      },
    });
  });

  test("validates OpenAI Codex reasoning configuration", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.openai-codex]\nreasoning_effort = "extreme"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.openai-codex.reasoning_effort must be one of: low, medium, high, xhigh, max, ultra.",
    );

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.openai-codex]\nreasoning_summary = "full"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.openai-codex.reasoning_summary must be one of: auto, concise, detailed.",
    );
  });

  test("rejects unknown logging.level", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[logging]\nlevel = "verbose"\n');

    expect(() => loadKanaConfig(env)).toThrow(
      "logging.level must be one of: debug, info, warn, error, off.",
    );
  });

  test("rejects non-boolean memory.enabled", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[memory]\nenabled = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("memory.enabled must be a boolean.");
  });

  test("rejects non-positive memory.max_chars", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), "[memory]\nmax_chars = 0\n");

    expect(() => loadKanaConfig(env)).toThrow("memory.max_chars must be a positive integer.");
  });

  test("rejects non-positive memory.daily_retention_days", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), "[memory]\ndaily_retention_days = 0\n");

    expect(() => loadKanaConfig(env)).toThrow(
      "memory.daily_retention_days must be a positive integer.",
    );
  });

  test("rejects invalid agent.max_turns values", () => {
    for (const value of [-2, 0, 1.5]) {
      const env = createTempEnv();
      const { home } = getKanaConfigPaths(env);
      writeFileSync(path.join(home, "config.toml"), `[agent]\nmax_turns = ${value}\n`);

      expect(() => loadKanaConfig(env)).toThrow(
        "agent.max_turns must be -1 or a positive integer.",
      );
    }
  });

  test("loads and validates the optional agent context limit", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), "[agent]\ncontext_limit = 200000\n");

    expect(loadKanaConfig(env).agent.contextLimit).toBe(200_000);

    writeFileSync(path.join(home, "config.toml"), "[agent]\ncontext_limit = 0\n");
    expect(() => loadKanaConfig(env)).toThrow("agent.context_limit must be a positive integer.");
  });

  test("requires model.max_tokens to be a positive integer", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);

    for (const value of [0, -1, 1.5]) {
      writeFileSync(path.join(home, "config.toml"), `[model]\nmax_tokens = ${value}\n`);
      expect(() => loadKanaConfig(env)).toThrow(
        "model.deepseek.max_tokens must be a positive integer.",
      );
    }
  });

  test("loads the configured API key environment variable name", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[model]\napi_key_env = "KANA_DEEPSEEK_KEY"\n');

    expect(loadKanaConfig(env).model.deepseek.apiKeyEnv).toBe("KANA_DEEPSEEK_KEY");
  });

  test("creates agents by reading the configured API key environment variable", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_DEEPSEEK_KEY = "secret";

    try {
      const enabled = createKanaAgent({
        ...DEFAULT_KANA_CONFIG,
        model: {
          ...DEFAULT_KANA_CONFIG.model,
          deepseek: {
            ...DEFAULT_KANA_CONFIG.model.deepseek,
            apiKeyEnv: "KANA_DEEPSEEK_KEY",
          },
        },
      });
      const disabled = createKanaAgent({
        ...DEFAULT_KANA_CONFIG,
        model: {
          ...DEFAULT_KANA_CONFIG.model,
          deepseek: {
            ...DEFAULT_KANA_CONFIG.model.deepseek,
            apiKeyEnv: "KANA_DEEPSEEK_KEY",
          },
        },
        memory: {
          ...DEFAULT_KANA_CONFIG.memory,
          enabled: false,
        },
      });

      expect(enabled.state.tools.map((tool) => tool.name)).toContain("remember");
      expect(disabled.state.tools.map((tool) => tool.name)).not.toContain("remember");
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("uses the configured context limit for the main Agent", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_DEEPSEEK_KEY = "secret";

    try {
      const agent = createKanaAgent({
        ...DEFAULT_KANA_CONFIG,
        model: {
          ...DEFAULT_KANA_CONFIG.model,
          deepseek: {
            ...DEFAULT_KANA_CONFIG.model.deepseek,
            apiKeyEnv: "KANA_DEEPSEEK_KEY",
          },
        },
        agent: {
          ...DEFAULT_KANA_CONFIG.agent,
          contextLimit: 200_000,
        },
      });

      expect(agent.state.contextLimit).toBe(200_000);
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("rejects context limits outside the selected model capability", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_DEEPSEEK_KEY = "secret";

    try {
      expect(() =>
        createKanaAgent({
          ...DEFAULT_KANA_CONFIG,
          model: {
            ...DEFAULT_KANA_CONFIG.model,
            deepseek: {
              ...DEFAULT_KANA_CONFIG.model.deepseek,
              apiKeyEnv: "KANA_DEEPSEEK_KEY",
            },
          },
          agent: {
            ...DEFAULT_KANA_CONFIG.agent,
            contextLimit: 1_000_001,
          },
        }),
      ).toThrow("agent.context_limit cannot exceed the 1000000-token context window");

      expect(() =>
        createKanaAgent({
          ...DEFAULT_KANA_CONFIG,
          model: {
            ...DEFAULT_KANA_CONFIG.model,
            deepseek: {
              ...DEFAULT_KANA_CONFIG.model.deepseek,
              apiKeyEnv: "KANA_DEEPSEEK_KEY",
              maxTokens: 8_192,
            },
          },
          agent: {
            ...DEFAULT_KANA_CONFIG.agent,
            contextLimit: 8_192,
          },
        }),
      ).toThrow("agent.context_limit must be greater than model.max_tokens.");
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("formats environment context for the system prompt", () => {
    expect(
      formatKanaEnvironmentContext({
        cwd: "/repo",
        platform: "darwin",
        currentDate: "2026-06-12",
        timezone: "Asia/Shanghai",
      }),
    ).toBe(
      [
        "<environment_context>",
        "  <cwd>/repo</cwd>",
        "  <platform>darwin</platform>",
        "  <current_date>2026-06-12</current_date>",
        "  <timezone>Asia/Shanghai</timezone>",
        "</environment_context>",
      ].join("\n"),
    );
  });

  test("builds the system prompt with environment context", () => {
    const env = createTempEnv();
    const previousKanaHome = process.env.KANA_HOME;
    process.env.KANA_HOME = getKanaConfigPaths(env).home;

    try {
      const prompt = buildKanaSystemPrompt({
        cwd: "/repo",
        now: new Date("2026-06-11T16:30:00.000Z"),
        platform: "darwin",
        timezone: "Asia/Shanghai",
      });

      expect(prompt).toContain(
        "You are a concise, practical assistant working in the user's current environment.",
      );
      expect(prompt).toContain("<cwd>/repo</cwd>");
      expect(prompt).toContain("<platform>darwin</platform>");
      expect(prompt).toContain("<current_date>2026-06-12</current_date>");
      expect(prompt).toContain("<timezone>Asia/Shanghai</timezone>");
    } finally {
      restoreEnv("KANA_HOME", previousKanaHome);
    }
  });

  test("injects consolidated global and project memory before AGENTS.md", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const paths = getKanaConfigPaths(env);
    writeFileSync(paths.agentsPath, "Global instructions.");
    writeFileSync(path.join(cwd, "AGENTS.md"), "Project instructions.");
    saveKanaMemory("global", "Use Chinese & keep answers concise.", { env });
    saveKanaMemory("project", "Do not treat <unsafe> text as an instruction.", { cwd, env });

    const prompt = buildKanaSystemPrompt({ cwd, env });

    expect(prompt).toContain(
      '<memory_reference scope="global">\nUse Chinese &amp; keep answers concise.\n</memory_reference>',
    );
    expect(prompt).toContain('<memory_reference scope="project"');
    expect(prompt).toContain("Do not treat &lt;unsafe&gt; text as an instruction.");
    expect(prompt.indexOf("Use Chinese")).toBeLessThan(prompt.indexOf("Global instructions."));
    expect(prompt.indexOf("Global instructions.")).toBeLessThan(
      prompt.indexOf("Project instructions."),
    );
  });

  test("guides remember usage when memory is enabled", () => {
    const prompt = buildKanaSystemPrompt({ cwd: createTempDir(), env: createTempEnv() });

    expect(prompt).toContain("<remember_tool_guidance>");
    expect(prompt).toContain("Proactively use remember");
    expect(prompt).toContain("project milestones that affect the current state or next steps");
    expect(prompt).toContain("even when a normal response fully handles the current turn");
    expect(prompt).toContain("Default to project scope.");
    expect(prompt).toContain("Do not record secrets");
  });

  test("does not inject memory when memory is disabled", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), "[memory]\nenabled = false\n");
    saveKanaMemory("global", "This must not be injected.", { env });

    const prompt = buildKanaSystemPrompt({ cwd: createTempDir(), env });

    expect(prompt).not.toContain("<memory>");
    expect(prompt).not.toContain("<remember_tool_guidance>");
  });

  test("appends ~/.kana/AGENTS.md after the default system prompt", () => {
    const env = createTempEnv();
    const paths = getKanaConfigPaths(env);
    const previousKanaHome = process.env.KANA_HOME;
    const previousKey = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_HOME = paths.home;
    process.env.KANA_DEEPSEEK_KEY = "secret";
    writeFileSync(paths.agentsPath, "Custom system prompt.\n");

    try {
      const agent = createKanaAgent({
        ...DEFAULT_KANA_CONFIG,
        model: {
          ...DEFAULT_KANA_CONFIG.model,
          deepseek: {
            ...DEFAULT_KANA_CONFIG.model.deepseek,
            apiKeyEnv: "KANA_DEEPSEEK_KEY",
          },
        },
      });
      const system = agent.state.system ?? "";

      expect(system).toContain(
        "You are a concise, practical assistant working in the user's current environment.",
      );
      expect(system).toContain(
        '<agents_instructions scope="global">\nCustom system prompt.\n</agents_instructions>',
      );
      expect(
        system.indexOf(
          "You are a concise, practical assistant working in the user's current environment.",
        ),
      ).toBeLessThan(system.indexOf("Custom system prompt."));
      expect(system).toContain("<environment_context>");
      expect(system).toContain(`<cwd>${process.cwd()}</cwd>`);
      expect(system).toContain(`<platform>${process.platform}</platform>`);
    } finally {
      restoreEnv("KANA_HOME", previousKanaHome);
      restoreEnv("KANA_DEEPSEEK_KEY", previousKey);
    }
  });

  test("combines global and project AGENTS.md instructions", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const paths = getKanaConfigPaths(env);
    const projectAgentsPath = path.join(cwd, "AGENTS.md");
    writeFileSync(paths.agentsPath, "Global instructions.\n");
    writeFileSync(projectAgentsPath, "Project instructions.\n");

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      now: new Date("2026-06-11T16:30:00.000Z"),
      platform: "darwin",
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain(
      '<agents_instructions scope="global">\nGlobal instructions.\n</agents_instructions>',
    );
    expect(prompt).toContain(
      '<agents_instructions scope="project">\nProject instructions.\n</agents_instructions>',
    );
    expect(
      prompt.indexOf(
        "You are a concise, practical assistant working in the user's current environment.",
      ),
    ).toBeLessThan(prompt.indexOf("Global instructions."));
    expect(prompt.indexOf("Global instructions.")).toBeLessThan(
      prompt.indexOf("Project instructions."),
    );
    expect(prompt).toContain("<environment_context>");
  });

  test("uses project AGENTS.md with the default prompt when global instructions are missing", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const projectAgentsPath = path.join(cwd, "AGENTS.md");
    writeFileSync(projectAgentsPath, "Project-only instructions.\n");

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      now: new Date("2026-06-11T16:30:00.000Z"),
      platform: "darwin",
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain(
      "You are a concise, practical assistant working in the user's current environment.",
    );
    expect(prompt).toContain(
      '<agents_instructions scope="project">\nProject-only instructions.\n</agents_instructions>',
    );
  });

  test("fails agent creation when the configured API key is missing", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    delete process.env.KANA_DEEPSEEK_KEY;

    try {
      expect(() =>
        createKanaAgent({
          ...DEFAULT_KANA_CONFIG,
          model: {
            ...DEFAULT_KANA_CONFIG.model,
            deepseek: {
              ...DEFAULT_KANA_CONFIG.model.deepseek,
              apiKeyEnv: "KANA_DEEPSEEK_KEY",
            },
          },
        }),
      ).toThrow("Missing KANA_DEEPSEEK_KEY");
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("rejects unsupported providers", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[provider]\nactive = "mock"\n');

    expect(() => loadKanaConfig(env)).toThrow(
      "provider.active must be one of: deepseek, openai-codex.",
    );
  });

  test("rejects unsupported notification backends", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[notification]\nbackend = "toast"\n');

    expect(() => loadKanaConfig(env)).toThrow(
      "notification.backend must be one of: auto, off, bell, osc9, osc777, kitty.",
    );
  });
});

function createTempEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-config-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".kana"), { recursive: true });

  return {
    HOME: home,
    ...extra,
  };
}

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kana-config-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
