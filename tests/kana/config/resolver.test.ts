import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getKanaConfigPaths, loadKanaConfig } from "@/kana";
import { resolveKanaMemoryAgentConfig } from "@/kana/config";
import { cleanupConfigTempDirs, createTempEnv } from "./config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana config resolver", () => {
  test("inherits unset memory model fields from the conversation Agent", () => {
    const env = createTempEnv();
    const { home } = getKanaConfigPaths(env);
    const configPath = path.join(home, "config.toml");

    writeFileSync(
      configPath,
      [
        "[agent.model]",
        'provider = "custom"',
        'name = "local-model"',
        'reasoning_effort = "high"',
        "max_output_tokens = 16384",
        "",
      ].join("\n"),
    );

    const inherited = loadKanaConfig(env);
    const inheritedAgent = resolveKanaMemoryAgentConfig(inherited);

    expect(inherited.memory.agent.model).toEqual({});
    expect(inheritedAgent.model).toEqual({
      provider: "custom",
      name: "local-model",
      reasoningEffort: "high",
      maxOutputTokens: 16_384,
      contextLimit: undefined,
    });
    expect(inheritedAgent.webSearch).toBe(false);
    expect(inheritedAgent.maxTurns).toBe(-1);

    writeFileSync(
      configPath,
      [
        "[agent.model]",
        'provider = "custom"',
        'name = "local-model"',
        'reasoning_effort = "high"',
        "max_output_tokens = 16384",
        "",
        "[memory.agent.model]",
        'name = "local-mini"',
        "",
      ].join("\n"),
    );

    expect(resolveKanaMemoryAgentConfig(loadKanaConfig(env)).model).toEqual({
      provider: "custom",
      name: "local-mini",
      reasoningEffort: "high",
      maxOutputTokens: 16_384,
      contextLimit: undefined,
    });
  });
});
