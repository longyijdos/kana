import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_KANA_CONFIG, getKanaConfigPaths, loadKanaConfig } from "@/kana";
import { cleanupConfigTempDirs, createTempEnv } from "./config-fixture";

type InvalidConfigCase = readonly [label: string, config: string, expectedError: string];

const invalidScalarConfigs: InvalidConfigCase[] = [
  [
    "logging.level = verbose",
    '[logging]\nlevel = "verbose"\n',
    "logging.level must be one of: debug, info, warn, error, off.",
  ],
  invalidBooleanConfig("memory", "enabled"),
  invalidPositiveIntegerConfig("memory", "max_chars", 0),
  invalidPositiveIntegerConfig("memory", "daily_retention_days", 0),
  ...[-2, 0, 1.5].map(
    (value): InvalidConfigCase => [
      `agent.max_turns = ${value}`,
      `[agent]\nmax_turns = ${value}\n`,
      "agent.max_turns must be -1 or a positive integer.",
    ],
  ),
  ...[0, -1, 1.5].flatMap((value) => [
    invalidPositiveIntegerConfig("agent", "tool_deadline_ms", value),
    invalidPositiveIntegerConfig("agent", "goal_max_rounds", value),
    invalidPositiveIntegerConfig("agent", "max_parallel_tool_calls", value),
    invalidPositiveIntegerConfig("agent.background_jobs", "max_concurrent", value),
  ]),
  invalidBooleanConfig("agent", "parallel_tool_calls"),
  invalidBooleanConfig("agent", "tool_result_artifacts"),
  invalidBooleanConfig("tui", "smooth_text_streaming"),
  invalidBooleanConfig("tui", "hyperlinks"),
  invalidBooleanConfig("tui", "render_latex"),
  invalidBooleanConfig("tui", "render_mermaid"),
  invalidBooleanConfig("tui", "collapse_long_pastes"),
  [
    "tui.theme",
    '[tui]\ntheme = "../unsafe"\n',
    "tui.theme must be a lowercase theme identifier using letters, numbers, underscores, or hyphens (maximum 64 characters).",
  ],
];

afterEach(cleanupConfigTempDirs);

describe("Kana config parser", () => {
  test("merges TOML config with defaults", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[provider.deepseek]",
        'api_key_env = "KANA_DEEPSEEK_KEY"',
        "",
        "[agent]",
        "web_search = false",
        "image_input = false",
        "max_turns = 4",
        "goal_max_rounds = 12",
        "tool_deadline_ms = 120000",
        "parallel_tool_calls = false",
        "max_parallel_tool_calls = 2",
        "tool_result_artifacts = false",
        "",
        "[agent.model]",
        'provider = "deepseek"',
        'name = "deepseek-v4-flash"',
        'reasoning_effort = "low"',
        "max_output_tokens = 4096",
        "context_limit = 200000",
        "",
        "[agent.background_jobs]",
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
        'theme = "solarized_dark"',
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
        "max_turns = 3",
        "parallel_tool_calls = false",
        "",
        "[memory.agent.model]",
        'provider = "openai-codex"',
        'name = "gpt-5.6-luna"',
        "max_output_tokens = 8192",
        "",
        "[logging]",
        'level = "debug"',
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env)).toEqual({
      ...DEFAULT_KANA_CONFIG,
      provider: {
        ...DEFAULT_KANA_CONFIG.provider,
        deepseek: {
          ...DEFAULT_KANA_CONFIG.provider.deepseek,
          apiKeyEnv: "KANA_DEEPSEEK_KEY",
        },
      },
      agent: {
        ...DEFAULT_KANA_CONFIG.agent,
        webSearch: false,
        imageInput: false,
        maxTurns: 4,
        goalMaxRounds: 12,
        toolDeadlineMs: 120_000,
        parallelToolCalls: false,
        maxParallelToolCalls: 2,
        model: {
          provider: "deepseek",
          name: "deepseek-v4-flash",
          reasoningEffort: "low",
          maxOutputTokens: 4096,
          contextLimit: 200000,
        },
        toolResultArtifacts: false,
        backgroundJobs: {
          maxConcurrent: 6,
        },
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
        theme: "solarized_dark",
        hyperlinks: false,
        renderLatex: false,
        renderMermaid: false,
        smoothTextStreaming: false,
        collapseLongPastes: false,
      },
      memory: {
        ...DEFAULT_KANA_CONFIG.memory,
        enabled: false,
        maxChars: 8000,
        dailyRetentionDays: 14,
        agent: {
          ...DEFAULT_KANA_CONFIG.memory.agent,
          maxTurns: 3,
          parallelToolCalls: false,
          model: {
            provider: "openai-codex",
            name: "gpt-5.6-luna",
            reasoningEffort: undefined,
            maxOutputTokens: 8192,
            contextLimit: undefined,
          },
        },
      },
      logging: {
        level: "debug",
      },
    });
  });

  test("loads static Agent policy and Custom model selection", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[agent]",
        "web_search = false",
        "image_input = false",
        "",
        "[agent.model]",
        'provider = "custom"',
        'name = "local-model"',
        'reasoning_effort = "high"',
        "max_output_tokens = 16384",
        "context_limit = 200000",
        "",
      ].join("\n"),
    );

    expect(loadKanaConfig(env).agent).toMatchObject({
      webSearch: false,
      imageInput: false,
      model: {
        provider: "custom",
        name: "local-model",
        reasoningEffort: "high",
        maxOutputTokens: 16_384,
        contextLimit: 200_000,
      },
    });
  });

  test("loads provider-specific OpenAI Codex transport configuration", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[provider.openai-codex]",
        'reasoning_summary = "concise"',
        "timeout_ms = 90000",
        "max_retries = 2",
        "",
        "[agent.model]",
        'provider = "openai-codex"',
        'name = "gpt-5.6-luna"',
        "",
      ].join("\n"),
    );

    const config = loadKanaConfig(env);
    expect(config.provider["openai-codex"]).toEqual({
      reasoningSummary: "concise",
      timeoutMs: 90_000,
      maxRetries: 2,
    });
    expect(config.agent.model).toMatchObject({
      provider: "openai-codex",
      name: "gpt-5.6-luna",
    });

    writeFileSync(
      path.join(home, "config.toml"),
      '[provider.openai-codex]\nreasoning_summary = "full"\n',
    );
    expect(() => loadKanaConfig(env)).toThrow(
      "provider.openai-codex.reasoning_summary must be one of: auto, concise, detailed.",
    );
  });

  test.each(invalidScalarConfigs)("rejects invalid %s", (_label, config, expectedError) => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), config);

    expect(() => loadKanaConfig(env)).toThrow(expectedError);
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

  test("loads and validates optional model budgets", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(
      path.join(home, "config.toml"),
      "[agent.model]\ncontext_limit = 200000\nmax_output_tokens = 4096\n",
    );

    expect(loadKanaConfig(env).agent.model).toMatchObject({
      contextLimit: 200_000,
      maxOutputTokens: 4096,
    });

    for (const key of ["context_limit", "max_output_tokens"]) {
      writeFileSync(path.join(home, "config.toml"), `[agent.model]\n${key} = 0\n`);
      expect(() => loadKanaConfig(env)).toThrow(`agent.model.${key} must be a positive integer.`);
    }
  });

  test("rejects unsupported providers", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    writeFileSync(path.join(home, "config.toml"), '[agent.model]\nprovider = "mock"\n');

    expect(() => loadKanaConfig(env)).toThrow(
      "agent.model.provider must be one of: deepseek, openai-codex, custom.",
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

function invalidBooleanConfig(section: string, key: string): InvalidConfigCase {
  const path = `${section}.${key}`;
  return [path, `[${section}]\n${key} = "invalid"\n`, `${path} must be a boolean.`];
}

function invalidPositiveIntegerConfig(
  section: string,
  key: string,
  value: number,
): InvalidConfigCase {
  const path = `${section}.${key}`;
  return [
    `${path} = ${value}`,
    `[${section}]\n${key} = ${value}\n`,
    `${path} must be a positive integer.`,
  ];
}
