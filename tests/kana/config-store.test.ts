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
  test("creates only main Agent selection overrides when config.toml is absent", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);

    const config = store.updateMainAgent({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[agent]",
        'provider = "openai-codex"',
        'model = "gpt-5.6-luna"',
        'reasoning_effort = "max"',
        "",
      ].join("\n"),
    );
    expect(config.agent.model).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    });
    expect(config.memory.agent.model).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("preserves comments, unrelated tables, and inactive overrides", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath, home } = getKanaConfigPaths(env);
    writeFileSync(
      configPath,
      [
        "# keep this comment",
        "[agent]",
        'provider = "deepseek"',
        'model = "deepseek-v4-pro"',
        "context_limit = 200000",
        'reasoning_summary = "future-codex-value"',
        "",
        "[custom]",
        'value = "untouched"',
        "",
      ].join("\n"),
    );

    const config = store.updateMainAgent({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
    });

    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain("# keep this comment");
    expect(updated).toContain('model = "deepseek-v4-flash"');
    expect(updated).toContain('reasoning_effort = "none"');
    expect(updated).toContain("context_limit = 200000");
    expect(updated).toContain('reasoning_summary = "future-codex-value"');
    expect(updated).toContain('[custom]\nvalue = "untouched"');
    expect(config.agent.model).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
    });
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("selects a Custom model without moving its catalog into config.toml", () => {
    const env = createTempEnv();
    installCustomProvider(env);
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);

    const config = store.updateMainAgent({
      provider: "custom",
      model: "local-model",
      reasoningEffort: "high",
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[agent]",
        'provider = "custom"',
        'model = "local-model"',
        'reasoning_effort = "high"',
        "",
      ].join("\n"),
    );
    expect(config.agent.model).toMatchObject({
      provider: "custom",
      model: "local-model",
      reasoningEffort: "high",
    });
  });

  test("leaves the original document untouched when validation fails", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);
    const original = ["# original", "[agent]", 'provider = "deepseek"', ""].join("\n");
    writeFileSync(configPath, original);

    expect(() =>
      store.updateMainAgent({
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "ultra",
      }),
    ).toThrow("agent.reasoning_effort must be one of: low, medium, high, xhigh, max.");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("validates the candidate runtime before committing", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);
    const original = ["# original", "[agent]", 'provider = "deepseek"', ""].join("\n");
    writeFileSync(configPath, original);

    expect(() =>
      store.updateMainAgent(
        { provider: "deepseek", model: "deepseek-v4-flash" },
        {
          beforeCommit: () => {
            throw new Error("candidate initialization failed");
          },
        },
      ),
    ).toThrow("candidate initialization failed");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("keeps clean-mode updates in memory", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);

    store.updateMainAgent(
      { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "none" },
      { persist: false },
    );

    expect(existsSync(configPath)).toBe(false);
    expect(store.load().agent.model).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "none",
    });
  });

  test("does not materialize a file when the effective selection does not change", () => {
    const env = createTempEnv();
    const store = createKanaConfigStore(env);
    const { configPath } = getKanaConfigPaths(env);

    store.updateMainAgent({ provider: "deepseek", model: "deepseek-v4-pro" });

    expect(existsSync(configPath)).toBe(false);
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-config-store-"));
  tempDirs.push(home);
  const kanaHome = path.join(home, ".kana");
  mkdirSync(kanaHome, { recursive: true });
  return { HOME: home, KANA_HOME: kanaHome };
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
