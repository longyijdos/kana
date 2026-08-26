import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKanaConfigStore, getKanaConfigPaths } from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana config store", () => {
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
      draft.agent.goalMaxRounds = 12;
      draft.agent.toolResultArtifacts = false;
      draft.agent.backgroundJobs.maxConcurrent = 6;
      draft.agent.repeatedToolCalls.reminderThresholds = [2, 4];
      draft.agent.repeatedToolCalls.excludedTools = ["remember", "status"];
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[agent]",
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

  test("preserves comments and unknown tables while changing known leaves", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
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
        "[custom]",
        'value = "untouched"',
        "",
      ].join("\n"),
    );

    store.update((draft) => {
      draft.agent.model.name = "deepseek-v4-flash";
      draft.agent.model.reasoningEffort = "none";
      draft.agent.model.contextLimit = undefined;
      draft.agent.webSearch = false;
      draft.agent.imageInput = false;
      draft.agent.toolDeadlineMs = 120_000;
      draft.agent.parallelToolCalls = false;
      draft.agent.maxParallelToolCalls = 2;
      draft.tui.hyperlinks = false;
      draft.tui.renderLatex = false;
      draft.tui.renderMermaid = false;
      draft.tui.smoothTextStreaming = false;
      draft.tui.collapseLongPastes = false;
    });

    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain("# keep this comment");
    expect(updated).toContain('name = "deepseek-v4-flash"');
    expect(updated).toContain('reasoning_effort = "none"');
    expect(updated).toContain("max_output_tokens = 64000");
    expect(updated).toContain("web_search = false");
    expect(updated).toContain("image_input = false");
    expect(updated).toContain("tool_deadline_ms = 120000");
    expect(updated).toContain("parallel_tool_calls = false");
    expect(updated).toContain("max_parallel_tool_calls = 2");
    expect(updated).toContain(
      "[tui]\nhyperlinks = false\nrender_latex = false\nrender_mermaid = false\nsmooth_text_streaming = false\ncollapse_long_pastes = false",
    );
    expect(updated).toContain('[custom]\nvalue = "untouched"');
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("switches only the main model and removes inapplicable reasoning", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
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
        'name = "deepseek-v4-flash"',
        'reasoning_effort = "low"',
        "",
      ].join("\n"),
    );
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
      '[memory.agent.model]\nprovider = "deepseek"\nname = "deepseek-v4-flash"\nreasoning_effort = "low"',
    );
    expect(config.agent.model).toEqual({
      provider: "custom",
      name: "local-model",
      reasoningEffort: undefined,
      maxOutputTokens: 64_000,
      contextLimit: 200_000,
    });
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

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-config-store-"));
  tempDirs.push(home);
  const kanaHome = path.join(home, ".kana");
  mkdirSync(kanaHome, { recursive: true });
  return {
    HOME: home,
    KANA_HOME: kanaHome,
  };
}
