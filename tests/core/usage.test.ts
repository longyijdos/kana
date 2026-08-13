import { describe, expect, test } from "bun:test";
import type { ModelCost, ModelUsage } from "@/core";
import { addModelUsage, calculateUsageCostCny } from "@/core";

const cost: ModelCost = {
  input: 3,
  output: 6,
  cacheRead: 0.025,
  cacheWrite: 0,
};

describe("core usage helpers", () => {
  test("adds model usage totals", () => {
    expect(
      addModelUsage(
        {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          promptCacheHitTokens: 90,
          reasoningTokens: 5,
        },
        {
          promptTokens: 50,
          completionTokens: 10,
          totalTokens: 60,
          promptCacheMissTokens: 50,
        },
      ),
    ).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      totalTokens: 180,
      promptCacheHitTokens: 90,
      promptCacheMissTokens: 50,
      reasoningTokens: 5,
    });
  });

  test("calculates cost with prompt cache hit and miss tokens", () => {
    const usage: ModelUsage = {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      totalTokens: 1_500_000,
      promptCacheHitTokens: 900_000,
      promptCacheMissTokens: 100_000,
    };

    expect(calculateUsageCostCny(usage, cost)).toBe(3.3225);
  });

  test("falls back to normal input pricing when cache details are missing", () => {
    const usage: ModelUsage = {
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      totalTokens: 1_500_000,
    };

    expect(calculateUsageCostCny(usage, cost)).toBe(6);
  });
});
