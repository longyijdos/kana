import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createKanaConfigStore, getKanaConfigPaths } from "@/kana";
import { resolveKanaMemoryAgentConfig } from "@/kana/config";
import { cleanupConfigTempDirs, createTempEnv } from "./config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana config store", () => {
  test("keeps startup overrides in memory while persisting only later model changes", () => {
    const env = createTempEnv();
    const { configPath } = getKanaConfigPaths(env);
    const document = '# preserved\n[agent]\nmax_turns = 10\n[agent.model]\nname = "disk-model"\n';
    writeFileSync(configPath, document);
    const store = createKanaConfigStore(env, [
      "agent.max_turns=50",
      "agent.web_search=false",
      'agent.tools=["bash", "read"]',
      'agent.model.name="temporary-model"',
      "agent.model.max_output_tokens=4096",
    ]);
    expect(store.load().agent).toMatchObject({
      maxTurns: 50,
      webSearch: false,
      tools: ["bash", "read"],
      model: { name: "temporary-model", maxOutputTokens: 4096 },
    });
    expect(readFileSync(configPath, "utf8")).toBe(document);
    const updated = store.update((draft) => {
      draft.agent.model.provider = "custom";
      draft.agent.model.name = "selected-model";
      draft.agent.model.reasoningEffort = undefined;
    });
    expect(updated.agent.maxTurns).toBe(50);
    expect(updated.agent.model.maxOutputTokens).toBe(4096);
    expect(readFileSync(configPath, "utf8")).toBe(
      '# preserved\n[agent]\nmax_turns = 10\n[agent.model]\nname = "selected-model"\nprovider = "custom"\n',
    );
  });

  test("applies ordered TOML overrides without creating a missing config file", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env, [
      "agent.max_turns=20",
      "agent.max_turns=50",
      'agent.model={ provider="custom", name="a=b" }',
      'provider.openai-codex.reasoning_summary="detailed"',
      "memory.agent.model.context_limit=8000",
    ]);
    expect(store.load().agent).toMatchObject({
      maxTurns: 50,
      model: { provider: "custom", name: "a=b" },
    });
    expect(store.load().memory.agent.model.contextLimit).toBe(8000);
    expect(existsSync(getKanaConfigPaths(env).configPath)).toBe(false);
  });

  test.each([
    ["agent.max_turns", "path=value"],
    ["agent..max_turns=50", "path=value"],
    ["agent.model.name=unquoted", "single valid TOML value"],
    ["agent.max_turns=50\nextra=1", "single valid TOML value"],
    ["agent.max_turns=0", "agent.max_turns"],
    ['agent.web_search="false"', "agent.web_search"],
    ["agent.tools=[1]", "agent.tools"],
    [
      "agent.max_turns.child=1",
      "Config override agent.max_turns.child traverses a non-table value",
    ],
    ["unknown.field=unquoted", "single valid TOML value"],
    ["unknown.field=true", "Unknown config field: unknown."],
    ["agent.unknown=42", "Unknown config field: agent.unknown"],
    ["agent.model.nam=42", "Unknown config field: agent.model.nam"],
    ['agent.model={nam="wrong"}', "Unknown config field: agent.model.nam"],
    ["__proto__.polluted=true", "Unknown config field: __proto__."],
  ])("rejects invalid startup override %s", (override, error) => {
    expect(() => createKanaConfigStore(createTempEnv(), [override])).toThrow(error);
  });

  test("does not hide invalid file configuration with a startup override", () => {
    const env = createTempEnv();
    writeFileSync(getKanaConfigPaths(env).configPath, "[agent]\nmax_turns = 0\n");
    expect(() => createKanaConfigStore(env, ["agent.max_turns=50"])).toThrow("agent.max_turns");
  });

  test("creates only changed overrides when config.toml is absent", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);

    const config = store.update((draft) => {
      draft.agent.model.provider = "openai-codex";
      draft.agent.model.name = "gpt-5.6-luna";
      draft.agent.model.reasoningEffort = "max";
      draft.agent.webSearch = false;
      draft.agent.imageInput = false;
      draft.agent.tools = ["read", "bash"];
      draft.agent.goalMaxRounds = 12;
      draft.agent.toolResultArtifacts = false;
      draft.agent.backgroundJobs.maxConcurrent = 6;
      draft.agent.repeatedToolCalls.reminderThresholds = [2, 4];
      draft.agent.repeatedToolCalls.excludedTools = ["remember", "status"];
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[agent]",
        'tools = ["read","bash"]',
        "web_search = false",
        "image_input = false",
        "goal_max_rounds = 12",
        "tool_result_artifacts = false",
        "",
        "[agent.model]",
        'provider = "openai-codex"',
        'name = "gpt-5.6-luna"',
        'reasoning_effort = "max"',
        "",
        "[agent.background_jobs]",
        "max_concurrent = 6",
        "",
        "[agent.repeated_tool_calls]",
        "reminder_thresholds = [2,4]",
        'excluded_tools = ["remember","status"]',
        "",
      ].join("\n"),
    );
    expect(config.agent.model).toMatchObject({
      provider: "openai-codex",
      name: "gpt-5.6-luna",
      reasoningEffort: "max",
    });
    expect(config.agent.webSearch).toBe(false);
    expect(config.agent.imageInput).toBe(false);
    expect(config.agent.tools).toEqual(["read", "bash"]);
    expect(config.agent.goalMaxRounds).toBe(12);
    expect(config.agent.toolResultArtifacts).toBe(false);
    expect(config.agent.backgroundJobs).toEqual({
      maxConcurrent: 6,
    });
    expect(config.agent.repeatedToolCalls).toEqual({
      reminderThresholds: [2, 4],
      excludedTools: ["remember", "status"],
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("preserves comments while changing known leaves", () => {
    const env = createTempEnv();
    const { configPath, home } = getKanaConfigPaths(env);
    writeFileSync(
      configPath,
      [
        "# keep this comment",
        "[agent.model]",
        'provider = "deepseek"',
        'name = "deepseek-v4-pro"',
        'reasoning_effort = "high"',
        "max_output_tokens = 64000",
        "",
      ].join("\n"),
    );
    const store = createKanaConfigStore(env);

    store.update((draft) => {
      draft.agent.model.name = "deepseek-flash";
      draft.agent.model.reasoningEffort = "none";
      draft.agent.model.contextLimit = undefined;
      draft.agent.webSearch = false;
      draft.agent.imageInput = false;
      draft.agent.toolDeadlineMs = 120_000;
      draft.agent.parallelToolCalls = false;
      draft.agent.maxParallelToolCalls = 2;
      draft.tui.theme = "solarized_dark";
      draft.tui.hyperlinks = false;
      draft.tui.renderLatex = false;
      draft.tui.renderMermaid = false;
      draft.tui.smoothTextStreaming = false;
      draft.tui.collapseLongPastes = false;
    });

    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain("# keep this comment");
    expect(updated).toContain('name = "deepseek-flash"');
    expect(updated).toContain('reasoning_effort = "none"');
    expect(updated).toContain("max_output_tokens = 64000");
    expect(updated).toContain("web_search = false");
    expect(updated).toContain("image_input = false");
    expect(updated).toContain("tool_deadline_ms = 120000");
    expect(updated).toContain("parallel_tool_calls = false");
    expect(updated).toContain("max_parallel_tool_calls = 2");
    expect(updated).toContain(
      '[tui]\ntheme = "solarized_dark"\nhyperlinks = false\nrender_latex = false\nrender_mermaid = false\nsmooth_text_streaming = false\ncollapse_long_pastes = false',
    );
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("switches only the main model and removes inapplicable reasoning", () => {
    const env = createTempEnv();
    const { configPath } = getKanaConfigPaths(env);

    writeFileSync(
      configPath,
      [
        "[agent.model]",
        'provider = "deepseek"',
        'name = "deepseek-v4-pro"',
        'reasoning_effort = "high"',
        "max_output_tokens = 64000",
        "context_limit = 200000",
        "",
        "[memory.agent.model]",
        'provider = "deepseek"',
        'name = "deepseek-flash"',
        'reasoning_effort = "low"',
        "",
      ].join("\n"),
    );
    const store = createKanaConfigStore(env);
    const config = store.update((draft) => {
      draft.agent.model.provider = "custom";
      draft.agent.model.name = "local-model";
      draft.agent.model.reasoningEffort = undefined;
    });

    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain('[agent.model]\nprovider = "custom"\nname = "local-model"');
    expect(updated).not.toContain('reasoning_effort = "high"');
    expect(updated).toContain("max_output_tokens = 64000");
    expect(updated).toContain("context_limit = 200000");
    expect(updated).toContain(
      '[memory.agent.model]\nprovider = "deepseek"\nname = "deepseek-flash"\nreasoning_effort = "low"',
    );
    expect(config.agent.model).toEqual({
      provider: "custom",
      name: "local-model",
      reasoningEffort: undefined,
      maxOutputTokens: 64_000,
      contextLimit: 200_000,
    });
    expect(resolveKanaMemoryAgentConfig(config).model).toEqual({
      provider: "deepseek",
      name: "deepseek-flash",
      reasoningEffort: "low",
      maxOutputTokens: 64_000,
      contextLimit: 200_000,
    });
  });

  test("keeps memory model inheritance out of the persisted file", () => {
    const env = createTempEnv();
    const { configPath } = getKanaConfigPaths(env);
    const store = createKanaConfigStore(env);

    const config = store.update((draft) => {
      draft.agent.model.provider = "openai-codex";
      draft.agent.model.name = "gpt-5.6-luna";
      draft.agent.model.reasoningEffort = "max";
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[agent.model]",
        'provider = "openai-codex"',
        'name = "gpt-5.6-luna"',
        'reasoning_effort = "max"',
        "",
      ].join("\n"),
    );
    expect(config.memory.agent.model).toEqual({});
    expect(resolveKanaMemoryAgentConfig(config).model).toMatchObject({
      provider: "openai-codex",
      name: "gpt-5.6-luna",
      reasoningEffort: "max",
    });
  });

  test("merges writes into the latest file without reloading unrelated runtime settings", () => {
    const env = createTempEnv();
    const { configPath } = getKanaConfigPaths(env);
    writeFileSync(
      configPath,
      ["[agent.model]", 'name = "deepseek-flash"', "", "[tui]", 'theme = "dark"', ""].join("\n"),
    );
    const store = createKanaConfigStore(env);

    writeFileSync(
      configPath,
      [
        "# external edit",
        "[agent.model]",
        'name = "deepseek-flash"',
        "",
        "[tui]",
        'theme = "ocean"',
        "",
      ].join("\n"),
    );

    const updated = store.update((draft) => {
      draft.agent.model.name = "deepseek-v4-pro";
    });

    const persisted = readFileSync(configPath, "utf8");
    expect(persisted).toContain("# external edit");
    expect(persisted).toContain('theme = "ocean"');
    expect(persisted).toContain('name = "deepseek-v4-pro"');
    expect(updated.tui.theme).toBe("dark");
    expect(store.load().tui.theme).toBe("dark");
    expect(createKanaConfigStore(env).load().tui.theme).toBe("ocean");
  });

  test("leaves the original document untouched when validation fails", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);
    const original = ["# original", "[agent]", "max_turns = 4", ""].join("\n");
    writeFileSync(configPath, original);

    expect(() =>
      store.update((draft) => {
        draft.agent.maxTurns = 0;
      }),
    ).toThrow("agent.max_turns must be -1 or a positive integer.");

    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("does not materialize a file when effective values do not change", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);

    store.update((draft) => {
      draft.agent.model.provider = "deepseek";
    });

    expect(existsSync(configPath)).toBe(false);
  });
});
