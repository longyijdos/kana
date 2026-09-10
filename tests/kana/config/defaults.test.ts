import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KANA_CONFIG,
  KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES,
  type KanaRepeatedToolCallsConfig,
} from "@/kana";

describe("Kana config defaults", () => {
  test("defines stable default policies", () => {
    const repeatedToolCalls: KanaRepeatedToolCallsConfig = {
      reminderThresholds: [3, 5, 8],
      excludedTools: [],
    };

    expect(DEFAULT_KANA_CONFIG.agent.model).toEqual({
      provider: "deepseek",
      name: "deepseek-flash",
      reasoningEffort: undefined,
      maxOutputTokens: undefined,
      contextLimit: undefined,
    });
    expect(DEFAULT_KANA_CONFIG.agent.webSearch).toBe(true);
    expect(DEFAULT_KANA_CONFIG.agent.imageInput).toBe(true);
    expect(DEFAULT_KANA_CONFIG.agent.tools).toEqual([...KANA_CONFIGURABLE_BUILT_IN_TOOL_NAMES]);
    expect(DEFAULT_KANA_CONFIG.memory.agent.model.name).toBe("deepseek-flash");
    expect(DEFAULT_KANA_CONFIG.memory.agent.webSearch).toBe(false);
    expect(DEFAULT_KANA_CONFIG.memory.agent.imageInput).toBe(false);
    expect(DEFAULT_KANA_CONFIG.agent.goalMaxRounds).toBe(8);
    expect(DEFAULT_KANA_CONFIG.agent.toolResultArtifacts).toBe(true);
    expect(DEFAULT_KANA_CONFIG.agent.backgroundJobs).toEqual({
      maxConcurrent: 4,
    });
    expect(DEFAULT_KANA_CONFIG.agent.subagents).toEqual({ maxLive: 4 });
    expect(DEFAULT_KANA_CONFIG.agent.repeatedToolCalls).toEqual(repeatedToolCalls);
    expect(DEFAULT_KANA_CONFIG.tui.theme).toBe("kana-dark");
  });
});
