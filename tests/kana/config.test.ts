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
  type KanaRepeatedToolCallsConfig,
  loadKanaConfig,
  loadKanaEnvironment,
  resetKanaConfig,
  saveKanaMemory,
} from "@/kana";
import { buildKanaPromptAssembly } from "../../src/kana/prompt";

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
      artifactsPath: "/home/kana/.kana/artifacts",
      logsPath: "/home/kana/.kana/logs",
      accountingPath: "/home/kana/.kana/accounting",
      approvalsPath: "/home/kana/.kana/approvals.json",
      skillsConfigPath: "/home/kana/.kana/skills/skills.toml",
      providersDirectory: "/home/kana/.kana/providers",
      customProviderPath: "/home/kana/.kana/providers/custom.toml",
      customProviderExamplePath: "/home/kana/.kana/providers/custom.example.toml",
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
    const installedCustomProviderExample = readFileSync(
      firstInstall.customProviderExamplePath,
      "utf8",
    );

    expect(firstInstall.configStatus).toBe("defaults");
    expect(firstInstall.configExampleStatus).toBe("created");
    expect(firstInstall.mcpConfigStatus).toBe("created");
    expect(firstInstall.mcpEnabledStatus).toBe("created");
    expect(firstInstall.approvalsStatus).toBe("created");
    expect(firstInstall.skillsConfigStatus).toBe("created");
    expect(firstInstall.customProviderExampleStatus).toBe("created");
    expect(fileExists(firstInstall.configPath)).toBe(false);
    expect(installedConfigExample).toContain("[provider.deepseek]");
    expect(installedConfigExample).toContain('[model.deepseek."deepseek-v4-pro"]');
    expect(installedConfigExample).toContain('[model.openai-codex."gpt-5.6-luna"]');
    expect(installedConfigExample).toContain("max_output_tokens = 384000");
    expect(installedConfigExample).toContain("web_search = true");
    expect(installedConfigExample).toContain("image_input = true");
    expect(installedConfigExample).toContain("[goal]\nmax_rounds = 8");
    expect(installedConfigExample).toContain("tool_deadline_ms = 660000");
    expect(installedConfigExample).toContain("parallel_tool_calls = true");
    expect(installedConfigExample).toContain("max_parallel_tool_calls = 4");
    expect(installedConfigExample).toContain("tool_result_artifacts = true");
    expect(installedConfigExample).toContain("[background_jobs]");
    expect(installedConfigExample).toContain("[memory.agent]");
    expect(installedConfigExample).toContain("[agent.repeated_tool_calls]");
    expect(installedConfigExample).toContain("reminder_thresholds = [3,5,8]");
    expect(installedConfigExample).toContain("excluded_tools = []");
    expect(installedConfigExample).toContain("hyperlinks = true");
    expect(installedConfigExample).toContain("render_latex = true");
    expect(installedConfigExample).toContain("render_mermaid = true");
    expect(installedConfigExample).toContain("smooth_text_streaming = true");
    expect(installedConfigExample).toContain("collapse_long_pastes = true");
    expect(installedConfigExample).toContain("Kana does not read this file.");
    expect(installedConfigExample).toContain(
      "Custom provider transport, model metadata, and defaults live in providers/custom.toml.",
    );
    expect(installedCustomProviderExample).toContain('base_url = "https://api.example.com/v1"');
    expect(installedCustomProviderExample).toContain("[[models]]");
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
      customProviderExamplePath: firstInstall.customProviderExamplePath,
      customProviderExampleStatus: "exists",
    });
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe("custom = true\n");
    expect(readFileSync(firstInstall.mcpConfigPath, "utf8")).toBe('{"custom":true}\n');
    expect(readFileSync(firstInstall.mcpEnabledPath, "utf8")).toBe(
      '{"enabledServers":["custom"]}\n',
    );
    expect(readFileSync(firstInstall.approvalsPath, "utf8")).toBe('{"custom":true}\n');
    expect(readFileSync(firstInstall.skillsConfigPath, "utf8")).toBe("custom = true\n");
  });

  test("resets only configuration state and preserves credentials and user data", () => {
    const env = createTempEnv();
    installKanaConfig(env);
    const paths = getKanaConfigPaths(env);
    writeFileSync(paths.configPath, "custom = true\n");
    writeFileSync(paths.configExamplePath, "stale template\n");
    writeFileSync(paths.mcpConfigPath, '{"custom":true}\n');
    writeFileSync(paths.mcpEnabledPath, '{"enabledServers":["custom"]}\n');
    writeFileSync(paths.approvalsPath, '{"custom":true}\n');
    writeFileSync(paths.skillsConfigPath, "custom = true\n");

    const preservedFiles = new Map([
      [path.join(paths.home, "oauth-tokens.json"), "oauth"],
      [paths.agentsPath, "global instructions"],
      [path.join(paths.sessionsPath, "session.jsonl"), "session"],
      [path.join(paths.memoryDirectory, "memory.md"), "memory"],
      [path.join(paths.accountingPath, "usage.jsonl"), "accounting"],
      [path.join(paths.logsPath, "session.jsonl"), "logs"],
      [path.join(paths.home, "skills", "kana-skills", "SKILL.md"), "default repository"],
      [path.join(paths.home, "skills", "personal", "SKILL.md"), "personal skill"],
    ]);
    for (const [filePath, content] of preservedFiles) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }

    const result = resetKanaConfig(env);

    expect(result).toEqual({
      configPath: paths.configPath,
      configRemoved: true,
      configExamplePath: paths.configExamplePath,
      mcpConfigPath: paths.mcpConfigPath,
      mcpEnabledPath: paths.mcpEnabledPath,
      approvalsPath: paths.approvalsPath,
      skillsConfigPath: paths.skillsConfigPath,
    });
    expect(fileExists(paths.configPath)).toBe(false);
    expect(readFileSync(paths.configExamplePath, "utf8")).not.toBe("stale template\n");
    expect(readFileSync(paths.configExamplePath, "utf8")).toContain(
      '[model.openai-codex."gpt-5.6-luna"]',
    );
    expect(JSON.parse(readFileSync(paths.mcpConfigPath, "utf8"))).toEqual({ mcpServers: {} });
    expect(JSON.parse(readFileSync(paths.mcpEnabledPath, "utf8"))).toEqual({
      enabledServers: [],
    });
    expect(JSON.parse(readFileSync(paths.approvalsPath, "utf8"))).toEqual(
      DEFAULT_KANA_TOOL_APPROVALS,
    );
    expect(readFileSync(paths.skillsConfigPath, "utf8")).toBe(
      ["[model_invocation]", "enabled = []", ""].join("\n"),
    );
    for (const [filePath, content] of preservedFiles) {
      expect(readFileSync(filePath, "utf8")).toBe(content);
    }
    expect(resetKanaConfig(env).configRemoved).toBe(false);
  });

  test("refreshes the generated config example without creating config.toml", () => {
    const env = createTempEnv();
    const firstInstall = installKanaConfig(env);
    writeFileSync(firstInstall.configExamplePath, "custom example\n");

    const secondInstall = installKanaConfig(env);

    expect(secondInstall.configStatus).toBe("defaults");
    expect(secondInstall.configExampleStatus).toBe("updated");
    expect(fileExists(secondInstall.configPath)).toBe(false);
    expect(readFileSync(secondInstall.configExamplePath, "utf8")).toContain(
      '[model.openai-codex."gpt-5.6-luna"]',
    );
  });

  test("loads defaults when config.toml is missing", () => {
    expect(loadKanaConfig(createTempEnv())).toEqual(DEFAULT_KANA_CONFIG);
  });

  test("uses explicit per-model defaults", () => {
    const repeatedToolCalls: KanaRepeatedToolCallsConfig = {
      reminderThresholds: [3, 5, 8],
      excludedTools: [],
    };

    expect(DEFAULT_KANA_CONFIG.model.deepseek).toEqual({
      "deepseek-v4-flash": {
        reasoningEffort: "high",
        webSearch: true,
        imageInput: false,
        maxOutputTokens: 384_000,
        contextLimit: 1_000_000,
      },
      "deepseek-v4-flash-vision-exp": {
        reasoningEffort: "high",
        webSearch: true,
        imageInput: true,
        maxOutputTokens: 384_000,
        contextLimit: 1_000_000,
      },
      "deepseek-v4-pro": {
        reasoningEffort: "high",
        webSearch: true,
        imageInput: false,
        maxOutputTokens: 384_000,
        contextLimit: 1_000_000,
      },
    });
    expect(DEFAULT_KANA_CONFIG.model["openai-codex"]).toEqual({
      "gpt-5.6-sol": {
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        webSearch: true,
        imageInput: true,
        maxOutputTokens: 128_000,
        contextLimit: 372_000,
      },
      "gpt-5.6-terra": {
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        webSearch: true,
        imageInput: true,
        maxOutputTokens: 128_000,
        contextLimit: 372_000,
      },
      "gpt-5.6-luna": {
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        webSearch: true,
        imageInput: true,
        maxOutputTokens: 128_000,
        contextLimit: 372_000,
      },
    });
    expect(DEFAULT_KANA_CONFIG.agent.model).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    expect(DEFAULT_KANA_CONFIG.memory.agent.model).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(DEFAULT_KANA_CONFIG.goal.maxRounds).toBe(8);
    expect(DEFAULT_KANA_CONFIG.agent.toolResultArtifacts).toBe(true);
    expect(DEFAULT_KANA_CONFIG.backgroundJobs).toEqual({
      maxConcurrent: 4,
    });
    expect(DEFAULT_KANA_CONFIG.agent.repeatedToolCalls).toEqual(repeatedToolCalls);
  });

  test("resolves provider, model-global, and per-Agent settings", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[provider.deepseek]",
        'api_key_env = "KANA_DEEPSEEK_KEY"',
        "timeout_ms = 90000",
        "max_retries = 2",
        "",
        '[model.deepseek."deepseek-v4-flash"]',
        'reasoning_effort = "low"',
        "web_search = false",
        "max_output_tokens = 4096",
        "",
        "[agent]",
        'provider = "deepseek"',
        'model = "deepseek-v4-flash"',
        'reasoning_effort = "none"',
        "max_turns = 4",
        "tool_deadline_ms = 120000",
        "parallel_tool_calls = false",
        "max_parallel_tool_calls = 2",
        "context_limit = 200000",
        "tool_result_artifacts = false",
        "",
        "[goal]",
        "max_rounds = 12",
        "",
        "[background_jobs]",
        "max_concurrent = 6",
        "",
        "[agent.repeated_tool_calls]",
        "reminder_thresholds = [2, 4]",
        'excluded_tools = ["remember"]',
        "",
        "[approval]",
        'mode = "unless_trusted"',
        "",
        "[notification]",
        'backend = "bell"',
        "on_agent_completed = false",
        "on_approval_required = true",
        "",
        "[tui]",
        "hyperlinks = false",
        "render_latex = false",
        "render_mermaid = false",
        "smooth_text_streaming = false",
        "collapse_long_pastes = false",
        "",
        "[memory]",
        "enabled = false",
        "max_chars = 8000",
        "daily_retention_days = 14",
        "",
        "[memory.agent]",
        'provider = "openai-codex"',
        'model = "gpt-5.6-luna"',
        'reasoning_effort = "high"',
        "max_turns = 2",
        "",
        "[logging]",
        'level = "debug"',
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env)).toMatchObject({
      provider: {
        deepseek: {
          apiKeyEnv: "KANA_DEEPSEEK_KEY",
          timeoutMs: 90_000,
          maxRetries: 2,
        },
      },
      model: { deepseek: { "deepseek-v4-flash": { reasoningEffort: "low" } } },
      agent: {
        model: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          reasoningEffort: "none",
          webSearch: false,
          maxOutputTokens: 4096,
          contextLimit: 200_000,
        },
        maxTurns: 4,
        toolDeadlineMs: 120_000,
        parallelToolCalls: false,
        maxParallelToolCalls: 2,
        toolResultArtifacts: false,
        repeatedToolCalls: {
          reminderThresholds: [2, 4],
          excludedTools: ["remember"],
        },
      },
      approval: {
        mode: "unless_trusted",
      },
      notification: {
        backend: "bell",
        onAgentCompleted: false,
        onApprovalRequired: true,
      },
      tui: {
        hyperlinks: false,
        renderLatex: false,
        renderMermaid: false,
        smoothTextStreaming: false,
        collapseLongPastes: false,
      },
      memory: {
        enabled: false,
        maxChars: 8000,
        dailyRetentionDays: 14,
        agent: {
          model: {
            provider: "openai-codex",
            model: "gpt-5.6-luna",
            reasoningEffort: "high",
          },
          maxTurns: 2,
        },
      },
      goal: { maxRounds: 12 },
      backgroundJobs: { maxConcurrent: 6 },
      logging: {
        level: "debug",
      },
    });
  });

  test("loads provider-specific DeepSeek feature configuration", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      '[model.deepseek."deepseek-v4-pro"]\nweb_search = false\nimage_input = true\n',
    );

    expect(loadKanaConfig(env).model.deepseek["deepseek-v4-pro"]).toEqual({
      ...DEFAULT_KANA_CONFIG.model.deepseek["deepseek-v4-pro"],
      webSearch: false,
      imageInput: true,
    });

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.deepseek."deepseek-v4-pro"]\nweb_search = "yes"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.deepseek.deepseek-v4-pro.web_search must be a boolean.",
    );

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.deepseek."deepseek-v4-pro"]\nimage_input = "yes"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.deepseek.deepseek-v4-pro.image_input must be a boolean.",
    );
  });

  test("accepts DeepSeek reasoning efforts including none", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      '[model.deepseek."deepseek-v4-pro"]\nreasoning_effort = "low"\n',
    );

    expect(loadKanaConfig(env).model.deepseek["deepseek-v4-pro"]?.reasoningEffort).toBe("low");

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.deepseek."deepseek-v4-pro"]\nreasoning_effort = "none"\n',
    );
    expect(loadKanaConfig(env).model.deepseek["deepseek-v4-pro"]?.reasoningEffort).toBe("none");

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.deepseek."deepseek-v4-pro"]\nreasoning_effort = "medium"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.deepseek.deepseek-v4-pro.reasoning_effort must be one of: none, low, high, max.",
    );
  });

  test("loads the static Custom provider selection", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    installCustomProvider(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[agent]",
        'provider = "custom"',
        'model = "local-model"',
        'reasoning_effort = "high"',
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env).agent.model).toMatchObject({
      provider: "custom",
      model: "local-model",
      reasoningEffort: "high",
    });

    writeFileSync(path.join(home, "config.toml"), '[agent]\nprovider = "custom"\n');
    expect(() => loadKanaConfig(env)).toThrow(
      'Custom model "deepseek-v4-pro" is not configured. Available models: local-model.',
    );
  });

  test("loads provider-specific OpenAI Codex configuration", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[provider.openai-codex]",
        "timeout_ms = 90000",
        "max_retries = 2",
        "",
        '[model.openai-codex."gpt-5.6-luna"]',
        'reasoning_effort = "high"',
        'reasoning_summary = "concise"',
        "web_search = false",
        "image_input = false",
        "max_output_tokens = 16384",
        "",
        "[agent]",
        'provider = "openai-codex"',
        'model = "gpt-5.6-luna"',
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env)).toMatchObject({
      provider: { "openai-codex": { timeoutMs: 90_000, maxRetries: 2 } },
      agent: {
        model: {
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          reasoningEffort: "high",
          reasoningSummary: "concise",
          webSearch: false,
          imageInput: false,
          maxOutputTokens: 16_384,
        },
      },
    });
  });

  test("validates OpenAI Codex reasoning configuration", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.openai-codex."gpt-5.6-luna"]\nreasoning_effort = "ultra"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.openai-codex.gpt-5.6-luna.reasoning_effort must be one of: low, medium, high, xhigh, max.",
    );

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.openai-codex."gpt-5.6-luna"]\nreasoning_summary = "full"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.openai-codex.gpt-5.6-luna.reasoning_summary must be one of: auto, concise, detailed.",
    );

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.openai-codex."gpt-5.6-luna"]\nweb_search = "yes"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.openai-codex.gpt-5.6-luna.web_search must be a boolean.",
    );

    writeFileSync(
      path.join(home, "config.toml"),
      '[model.openai-codex."gpt-5.6-luna"]\nimage_input = "yes"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "model.openai-codex.gpt-5.6-luna.image_input must be a boolean.",
    );
  });

  test("gives Agent invocation overrides precedence over concrete-model defaults", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        '[model.openai-codex."gpt-5.6-luna"]',
        'reasoning_effort = "high"',
        "web_search = true",
        "max_output_tokens = 8192",
        "context_limit = 300000",
        "",
        "[agent]",
        'provider = "openai-codex"',
        'model = "gpt-5.6-luna"',
        'reasoning_effort = "max"',
        "web_search = false",
        "max_output_tokens = 4096",
        "context_limit = 200000",
        "",
        "[memory.agent]",
        'provider = "openai-codex"',
        'model = "gpt-5.6-luna"',
        "",
      ].join("\n"),
    );

    const config = loadKanaConfig(env);
    expect(config.agent.model).toMatchObject({
      reasoningEffort: "max",
      webSearch: false,
      maxOutputTokens: 4096,
      contextLimit: 200_000,
    });
    expect(config.memory.agent.model).toMatchObject({
      reasoningEffort: "high",
      webSearch: true,
      maxOutputTokens: 8192,
      contextLimit: 300_000,
    });
  });

  test("ignores known inapplicable overrides but validates them once applicable", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    const configPath = path.join(home, "config.toml");
    writeFileSync(
      configPath,
      [
        "[agent]",
        'provider = "deepseek"',
        'model = "deepseek-v4-pro"',
        "reasoning_summary = 42",
        'image_input = "invalid"',
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env).agent.model).toMatchObject({
      provider: "deepseek",
      imageInput: false,
    });

    writeFileSync(
      configPath,
      [
        "[agent]",
        'provider = "openai-codex"',
        'model = "gpt-5.6-luna"',
        "reasoning_summary = 42",
        'image_input = "invalid"',
        "",
      ].join("\n"),
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "agent.reasoning_summary must be a non-empty string.",
    );
  });

  test("rejects unknown Agent overrides and legacy output-limit names", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    const configPath = path.join(home, "config.toml");

    writeFileSync(configPath, "[agent]\ntypo = true\n");
    expect(() => loadKanaConfig(env)).toThrow("agent.typo is not a supported setting.");

    writeFileSync(configPath, '[model.deepseek."deepseek-v4-pro"]\nmax_tokens = 4096\n');
    expect(() => loadKanaConfig(env)).toThrow(
      "model.deepseek.deepseek-v4-pro.max_tokens is not a supported setting.",
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

  test("requires agent.tool_deadline_ms to be a positive integer", () => {
    for (const value of [0, -1, 1.5]) {
      const env = createTempEnv();
      const { home } = getKanaConfigPaths(env);
      writeFileSync(path.join(home, "config.toml"), `[agent]\ntool_deadline_ms = ${value}\n`);

      expect(() => loadKanaConfig(env)).toThrow(
        "agent.tool_deadline_ms must be a positive integer.",
      );
    }
  });

  test("requires goal.max_rounds to be a positive integer", () => {
    for (const value of [0, -1, 1.5]) {
      const env = createTempEnv();
      const { home } = getKanaConfigPaths(env);
      writeFileSync(path.join(home, "config.toml"), `[goal]\nmax_rounds = ${value}\n`);

      expect(() => loadKanaConfig(env)).toThrow("goal.max_rounds must be a positive integer.");
    }
  });

  test("requires agent.parallel_tool_calls to be a boolean", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[agent]\nparallel_tool_calls = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("agent.parallel_tool_calls must be a boolean.");
  });

  test("requires agent.max_parallel_tool_calls to be a positive integer", () => {
    for (const value of [0, -1, 1.5]) {
      const env = createTempEnv();
      const { home } = getKanaConfigPaths(env);
      writeFileSync(
        path.join(home, "config.toml"),
        `[agent]\nmax_parallel_tool_calls = ${value}\n`,
      );

      expect(() => loadKanaConfig(env)).toThrow(
        "agent.max_parallel_tool_calls must be a positive integer.",
      );
    }
  });

  test("requires Background Job limits to be positive integers", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    const configPath = path.join(home, "config.toml");

    for (const value of [0, -1, 1.5]) {
      writeFileSync(configPath, `[background_jobs]\nmax_concurrent = ${value}\n`);
      expect(() => loadKanaConfig(env)).toThrow(
        "background_jobs.max_concurrent must be a positive integer.",
      );
    }
  });

  test("loads and validates repeated tool-call policy settings", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    const configPath = path.join(home, "config.toml");

    writeFileSync(
      configPath,
      [
        "[agent.repeated_tool_calls]",
        "reminder_thresholds = []",
        'excluded_tools = ["remember", "status"]',
        "",
      ].join("\n"),
    );
    expect(loadKanaConfig(env).agent.repeatedToolCalls).toEqual({
      reminderThresholds: [],
      excludedTools: ["remember", "status"],
    });

    for (const value of ["1", '"invalid"', "[1]", "[3, 3]", "[4, 3]", "[2.5]"]) {
      writeFileSync(configPath, `[agent.repeated_tool_calls]\nreminder_thresholds = ${value}\n`);
      expect(() => loadKanaConfig(env)).toThrow();
    }

    for (const value of ['"invalid"', '[""]', '[" remember"]', '["read", "read"]']) {
      writeFileSync(configPath, `[agent.repeated_tool_calls]\nexcluded_tools = ${value}\n`);
      expect(() => loadKanaConfig(env)).toThrow();
    }
  });

  test("requires tui.smooth_text_streaming to be a boolean", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[tui]\nsmooth_text_streaming = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("tui.smooth_text_streaming must be a boolean.");
  });

  test("requires tui.hyperlinks to be a boolean", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[tui]\nhyperlinks = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("tui.hyperlinks must be a boolean.");
  });

  test("requires tui.render_latex to be a boolean", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[tui]\nrender_latex = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("tui.render_latex must be a boolean.");
  });

  test("requires tui.render_mermaid to be a boolean", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[tui]\nrender_mermaid = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("tui.render_mermaid must be a boolean.");
  });

  test("requires tui.collapse_long_pastes to be a boolean", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[tui]\ncollapse_long_pastes = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("tui.collapse_long_pastes must be a boolean.");
  });

  test("loads and validates the optional agent context limit", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), "[agent]\ncontext_limit = 200000\n");

    expect(loadKanaConfig(env).agent.model.contextLimit).toBe(200_000);

    writeFileSync(path.join(home, "config.toml"), "[agent]\ncontext_limit = 2000000\n");
    expect(loadKanaConfig(env).agent.model.contextLimit).toBe(1_000_000);

    writeFileSync(path.join(home, "config.toml"), "[agent]\ncontext_limit = 0\n");
    expect(() => loadKanaConfig(env)).toThrow("agent.context_limit must be a positive integer.");
  });

  test("requires agent.tool_result_artifacts to be a boolean", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[agent]\ntool_result_artifacts = "yes"\n');

    expect(() => loadKanaConfig(env)).toThrow("agent.tool_result_artifacts must be a boolean.");
  });

  test("requires model.max_output_tokens to be a positive integer", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);

    for (const value of [0, -1, 1.5]) {
      writeFileSync(
        path.join(home, "config.toml"),
        `[model.deepseek."deepseek-v4-pro"]\nmax_output_tokens = ${value}\n`,
      );
      expect(() => loadKanaConfig(env)).toThrow(
        "model.deepseek.deepseek-v4-pro.max_output_tokens must be a positive integer.",
      );
    }
  });

  test("loads the configured API key environment variable name", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      '[provider.deepseek]\napi_key_env = "KANA_DEEPSEEK_KEY"\n',
    );

    expect(loadKanaConfig(env).provider.deepseek.apiKeyEnv).toBe("KANA_DEEPSEEK_KEY");
  });

  test("creates agents by reading the configured API key environment variable", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_DEEPSEEK_KEY = "secret";

    try {
      const enabled = createKanaAgent(testAgentConfig());
      const disabled = createKanaAgent(testAgentConfig({ memoryEnabled: false }));

      expect(enabled.state.tools.map((tool) => tool.name)).toContain("remember");
      expect(disabled.state.tools.map((tool) => tool.name)).not.toContain("remember");
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("uses the configured Agent runtime limits", () => {
    const previous = process.env.KANA_DEEPSEEK_KEY;
    process.env.KANA_DEEPSEEK_KEY = "secret";

    try {
      const agent = createKanaAgent(
        testAgentConfig({ contextLimit: 200_000, toolDeadlineMs: 120_000 }),
      );

      expect(agent.state.toolDeadlineMs).toBe(120_000);
      expect(agent.state.contextLimit).toBe(200_000);
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("formats environment context for model input", () => {
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

  test("keeps environment context dynamic and outside the stable system prompt", async () => {
    const env = createTempEnv();
    const previousKanaHome = process.env.KANA_HOME;
    process.env.KANA_HOME = getKanaConfigPaths(env).home;

    try {
      const assembly = buildKanaPromptAssembly({
        cwd: "/repo",
        now: new Date("2026-06-11T16:30:00.000Z"),
        platform: "darwin",
        timezone: "Asia/Shanghai",
      });
      const prompt = await assembly.assemble({ signal: new AbortController().signal });

      expect(prompt.system).toContain(
        "You are a concise, practical assistant working in the user's current environment.",
      );
      expect(prompt.system).not.toContain("<environment_context>");
      expect(prompt.context).toEqual([
        {
          source: "environment",
          status: "active",
          content: [
            "<environment_context>",
            "  <cwd>/repo</cwd>",
            "  <platform>darwin</platform>",
            "  <current_date>2026-06-12</current_date>",
            "  <timezone>Asia/Shanghai</timezone>",
            "</environment_context>",
          ].join("\n"),
        },
      ]);
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

  test("uses only built-in instructions in clean mode", () => {
    const env = createTempEnv();
    const cwd = createTempDir();
    const paths = getKanaConfigPaths(env);
    writeFileSync(paths.agentsPath, "Global instructions.");
    writeFileSync(path.join(cwd, "AGENTS.md"), "Project instructions.");
    saveKanaMemory("global", "Global memory.", { env });
    saveKanaMemory("project", "Project memory.", { cwd, env });

    const prompt = buildKanaSystemPrompt({
      cwd,
      env,
      launchMode: "clean",
      skills: [
        {
          name: "custom-skill",
          description: "Custom skill.",
          filePath: path.join(cwd, ".kana", "skills", "custom-skill", "SKILL.md"),
          baseDir: path.join(cwd, ".kana", "skills", "custom-skill"),
        },
      ],
    });

    expect(prompt).toContain(
      "You are a concise, practical assistant working in the user's current environment.",
    );
    expect(prompt).not.toContain("<environment_context>");
    expect(prompt).not.toContain("Global instructions.");
    expect(prompt).not.toContain("Project instructions.");
    expect(prompt).not.toContain("Global memory.");
    expect(prompt).not.toContain("Project memory.");
    expect(prompt).not.toContain("<remember_tool_guidance>");
    expect(prompt).not.toContain("custom-skill");
  });

  test("keeps remember guidance out of the stable system prompt", () => {
    const prompt = buildKanaSystemPrompt({ cwd: createTempDir(), env: createTempEnv() });

    expect(prompt).not.toContain("<remember_tool_guidance>");
    expect(prompt).not.toContain("Proactively use remember");
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
      const agent = createKanaAgent(testAgentConfig());
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
      expect(system).not.toContain("<environment_context>");
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
    expect(prompt).not.toContain("<environment_context>");
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
      expect(() => createKanaAgent(testAgentConfig())).toThrow("Missing KANA_DEEPSEEK_KEY");
    } finally {
      restoreEnv("KANA_DEEPSEEK_KEY", previous);
    }
  });

  test("rejects unsupported providers", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[agent]\nprovider = "mock"\nmodel = "mock"\n');

    expect(() => loadKanaConfig(env)).toThrow(
      "agent.provider must be one of: deepseek, openai-codex, custom.",
    );
  });

  test("rejects the legacy global active-provider layout", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[provider]\nactive = "deepseek"\n');

    expect(() => loadKanaConfig(env)).toThrow("provider.active is not a supported setting.");
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

function installCustomProvider(env: NodeJS.ProcessEnv): void {
  const { providersDirectory, customProviderPath } = getKanaConfigPaths(env);
  mkdirSync(providersDirectory, { recursive: true });
  writeFileSync(
    customProviderPath,
    [
      'base_url = "http://127.0.0.1:11434/v1"',
      'api_key_env = "CUSTOM_API_KEY"',
      "",
      "[[models]]",
      'name = "local-model"',
      "context_window = 32768",
      "max_output_tokens = 4096",
      'reasoning_efforts = ["low", "high"]',
      'default_reasoning_effort = "low"',
      "",
    ].join("\n"),
  );
}

function testAgentConfig(
  overrides: { contextLimit?: number; memoryEnabled?: boolean; toolDeadlineMs?: number } = {},
) {
  const model = DEFAULT_KANA_CONFIG.agent.model;
  if (model.provider !== "deepseek") throw new Error("Expected the default DeepSeek model.");
  return {
    ...DEFAULT_KANA_CONFIG.agent,
    memoryEnabled: overrides.memoryEnabled ?? DEFAULT_KANA_CONFIG.agent.memoryEnabled,
    toolDeadlineMs: overrides.toolDeadlineMs ?? DEFAULT_KANA_CONFIG.agent.toolDeadlineMs,
    model: {
      ...model,
      apiKeyEnv: "KANA_DEEPSEEK_KEY",
      contextLimit: overrides.contextLimit ?? model.contextLimit,
    },
  };
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
