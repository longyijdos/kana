import { describe, expect, test } from "bun:test";
import { DEFAULT_KANA_CONFIG } from "@/kana";
import { createKanaAgentModelRuntime, resolveKanaModelReasoning } from "../../src/kana/model";

describe("Kana model runtime", () => {
  test("clamps Agent policy and budgets to model metadata", () => {
    const runtime = createKanaAgentModelRuntime(
      {
        ...DEFAULT_KANA_CONFIG.agent,
        model: {
          ...DEFAULT_KANA_CONFIG.agent.model,
          maxOutputTokens: 500_000,
          contextLimit: 2_000_000,
        },
      },
      DEFAULT_KANA_CONFIG.provider,
      { env: { DEEPSEEK_API_KEY: "secret" } },
    );

    expect(runtime.webSearch).toBe(true);
    expect(runtime.imageInput).toBe(false);
    expect(runtime.parallelToolCalls).toBe(true);
    expect(runtime.maxOutputTokens).toBe(384_000);
    expect(runtime.contextLimit).toBe(1_000_000);
  });

  test("uses metadata defaults and validates configured reasoning", () => {
    expect(
      resolveKanaModelReasoning(
        { efforts: ["none", "low", "high"], defaultEffort: "high" },
        undefined,
        "Test model",
      ),
    ).toBe("high");
    expect(() =>
      resolveKanaModelReasoning(
        { efforts: ["none", "low", "high"], defaultEffort: "high" },
        "medium",
        "Test model",
      ),
    ).toThrow("Test model reasoning_effort must be one of: none, low, high.");
    expect(() => resolveKanaModelReasoning(undefined, "low", "Test model")).toThrow(
      "Test model does not expose reasoning controls.",
    );
  });
});
