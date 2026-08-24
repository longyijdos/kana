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
      draft.provider.active = "openai-codex";
      draft.model["openai-codex"].name = "gpt-5.6-luna";
      draft.model["openai-codex"].reasoningEffort = "max";
      draft.model["openai-codex"].webSearch = false;
      draft.model["openai-codex"].imageInput = false;
      draft.agent.goalMaxRounds = 12;
      draft.agent.toolResultArtifacts = false;
      draft.agent.repeatedToolCalls.reminderThresholds = [2, 4];
      draft.agent.repeatedToolCalls.excludedTools = ["remember", "status"];
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[provider]",
        'active = "openai-codex"',
        "",
        "[model.openai-codex]",
        'name = "gpt-5.6-luna"',
        'reasoning_effort = "max"',
        "web_search = false",
        "image_input = false",
        "",
        "[agent]",
        "goal_max_rounds = 12",
        "tool_result_artifacts = false",
        "",
        "[agent.repeated_tool_calls]",
        "reminder_thresholds = [2,4]",
        'excluded_tools = ["remember","status"]',
        "",
      ].join("\n"),
    );
    expect(config.provider.active).toBe("openai-codex");
    expect(config.model["openai-codex"].name).toBe("gpt-5.6-luna");
    expect(config.model["openai-codex"].reasoningEffort).toBe("max");
    expect(config.model["openai-codex"].webSearch).toBe(false);
    expect(config.model["openai-codex"].imageInput).toBe(false);
    expect(config.agent.goalMaxRounds).toBe(12);
    expect(config.agent.toolResultArtifacts).toBe(false);
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
        "[model.deepseek]",
        'name = "deepseek-v4-pro"',
        "",
        "[agent]",
        "context_limit = 200000",
        "",
        "[custom]",
        'value = "untouched"',
        "",
      ].join("\n"),
    );

    store.update((draft) => {
      draft.model.deepseek.name = "deepseek-v4-flash";
      draft.model.deepseek.reasoningEffort = "none";
      draft.model.deepseek.webSearch = false;
      draft.model.deepseek.imageInput = false;
      draft.agent.toolDeadlineMs = 120_000;
      draft.agent.parallelToolCalls = false;
      draft.agent.maxParallelToolCalls = 2;
      draft.agent.contextLimit = undefined;
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
    expect(updated).toContain("web_search = false");
    expect(updated).toContain("image_input = false");
    expect(updated).toContain("tool_deadline_ms = 120000");
    expect(updated).toContain("parallel_tool_calls = false");
    expect(updated).toContain("max_parallel_tool_calls = 2");
    expect(updated).toContain(
      "[tui]\nhyperlinks = false\nrender_latex = false\nrender_mermaid = false\nsmooth_text_streaming = false\ncollapse_long_pastes = false",
    );
    expect(updated).not.toContain("context_limit");
    expect(updated).toContain('[custom]\nvalue = "untouched"');
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("persists only the selected Custom model fields", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);

    const config = store.update((draft) => {
      draft.provider.active = "custom";
      draft.model.custom.name = "local-model";
      draft.model.custom.reasoningEffort = "high";
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[provider]",
        'active = "custom"',
        "",
        "[model.custom]",
        'name = "local-model"',
        'reasoning_effort = "high"',
        "",
      ].join("\n"),
    );
    expect(config.model.custom).toEqual({ name: "local-model", reasoningEffort: "high" });
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
      draft.provider.active = "deepseek";
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
