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
      draft.model["openai-codex"].reasoningEffort = "ultra";
    });

    expect(readFileSync(configPath, "utf8")).toBe(
      [
        "[provider]",
        'active = "openai-codex"',
        "",
        "[model.openai-codex]",
        'name = "gpt-5.6-luna"',
        'reasoning_effort = "ultra"',
        "",
      ].join("\n"),
    );
    expect(config.provider.active).toBe("openai-codex");
    expect(config.model["openai-codex"].name).toBe("gpt-5.6-luna");
    expect(config.model["openai-codex"].reasoningEffort).toBe("ultra");
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
      draft.model.deepseek.thinking = false;
      draft.agent.contextLimit = undefined;
    });

    const updated = readFileSync(configPath, "utf8");
    expect(updated).toContain("# keep this comment");
    expect(updated).toContain('name = "deepseek-v4-flash"');
    expect(updated).toContain("thinking = false");
    expect(updated).not.toContain("context_limit");
    expect(updated).toContain('[custom]\nvalue = "untouched"');
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
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
