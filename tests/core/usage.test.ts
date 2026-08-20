import { describe, expect, test } from "bun:test";
import { addModelUsage } from "@/core";

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
});
