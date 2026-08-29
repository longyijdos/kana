import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createKanaAgent, DEFAULT_KANA_CONFIG, getKanaConfigPaths, type KanaConfig } from "@/kana";
import { cleanupConfigTempDirs, createTempEnv } from "./config/config-fixture";

afterEach(cleanupConfigTempDirs);

describe("Kana Agent configuration", () => {
  test("wires memory policy into Agent tools", () => {
    const env = createTempEnv({ KANA_DEEPSEEK_KEY: "secret" });
    const enabled = createAgentFromConfig(CONFIG_WITH_TEST_KEY, env);
    const disabled = createAgentFromConfig(
      {
        ...CONFIG_WITH_TEST_KEY,
        memory: {
          ...CONFIG_WITH_TEST_KEY.memory,
          enabled: false,
        },
      },
      env,
    );

    expect(enabled.state.tools.map((tool) => tool.name)).toContain("remember");
    expect(disabled.state.tools.map((tool) => tool.name)).not.toContain("remember");
  });

  test("uses the configured Agent runtime limits", () => {
    const env = createTempEnv({ KANA_DEEPSEEK_KEY: "secret" });
    const agent = createAgentFromConfig(
      {
        ...CONFIG_WITH_TEST_KEY,
        agent: {
          ...CONFIG_WITH_TEST_KEY.agent,
          toolDeadlineMs: 120_000,
          model: {
            ...CONFIG_WITH_TEST_KEY.agent.model,
            contextLimit: 200_000,
          },
        },
      },
      env,
    );

    expect(agent.state.toolDeadlineMs).toBe(120_000);
    expect(agent.state.contextLimit).toBe(200_000);
  });

  test("passes configured prompt inputs to Agent construction", () => {
    const env = createTempEnv({ KANA_DEEPSEEK_KEY: "secret" });
    const paths = getKanaConfigPaths(env);
    writeFileSync(paths.agentsPath, "Custom system prompt.\n");

    const agent = createAgentFromConfig(CONFIG_WITH_TEST_KEY, env);

    expect(agent.state.system).toContain("Custom system prompt.");
  });

  test("fails agent creation when the configured API key is missing", () => {
    expect(() => createAgentFromConfig(CONFIG_WITH_TEST_KEY, createTempEnv())).toThrow(
      "Missing KANA_DEEPSEEK_KEY",
    );
  });
});

const CONFIG_WITH_TEST_KEY: KanaConfig = {
  ...DEFAULT_KANA_CONFIG,
  provider: {
    ...DEFAULT_KANA_CONFIG.provider,
    deepseek: {
      ...DEFAULT_KANA_CONFIG.provider.deepseek,
      apiKeyEnv: "KANA_DEEPSEEK_KEY",
    },
  },
};

function createAgentFromConfig(config: KanaConfig, env: NodeJS.ProcessEnv) {
  return createKanaAgent(
    config.agent,
    {
      providers: config.provider,
      memoryEnabled: config.memory.enabled,
    },
    { env },
  );
}
