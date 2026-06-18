import { describe, expect, test } from "bun:test";
import type { Message, ModelCost, ModelUsage } from "@/core";
import {
  calculateContextUsedPercent,
  calculateUsageCostCny,
  findLatestAssistantUsage,
} from "@/core";

const cost: ModelCost = {
  input: 3,
  output: 6,
  cacheRead: 0.025,
  cacheWrite: 0,
};

describe("core usage helpers", () => {
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

  test("calculates context used from prompt tokens", () => {
    expect(
      calculateContextUsedPercent(
        {
          promptTokens: 123_456,
          completionTokens: 1,
          totalTokens: 123_457,
        },
        1_000_000,
      ),
    ).toBe(12);
  });

  test("finds the latest assistant usage in message history", () => {
    const latestUsage: ModelUsage = {
      promptTokens: 30,
      completionTokens: 4,
      totalTokens: 34,
    };
    const messages: Message[] = [
      {
        role: "assistant",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
        },
        content: [],
      },
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        usage: latestUsage,
        content: [],
      },
    ];

    expect(findLatestAssistantUsage(messages)).toBe(latestUsage);
  });
});
