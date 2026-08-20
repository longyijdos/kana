import { describe, expect, test } from "bun:test";
import type { KanaUsageSummary } from "@/kana";
import { UsageSummaryBlock } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";

describe("tui usage summary", () => {
  test("keeps token bars and usage columns aligned across variable-width values", () => {
    const rendered = new UsageSummaryBlock(createUsageSummary()).render(100).map(stripAnsi);

    const tokenRows = ["Input", "Cached", "Output", "Reasoning"].map(
      (label) => rendered.find((line) => line.startsWith(label))!,
    );
    const barStarts = tokenRows.map((line) => line.search(/[█░]/));

    expect(barStarts).toEqual([barStarts[0], barStarts[0], barStarts[0], barStarts[0]]);

    const runsStart = rendered.indexOf("Runs");
    const runRows = rendered.slice(runsStart + 1, runsStart + 4);
    expect(new Set(runRows.map((line) => line.indexOf("tokens"))).size).toBe(1);
    expect(runRows).toEqual([
      "Main          2296  150,000,000 tokens",
      "Memory auto     57    7,000,000 tokens",
      "Memory manual    8      633,440 tokens",
    ]);

    const modelRows = rendered.filter((line) => line.includes(" runs  "));
    expect(modelRows).toHaveLength(3);
    expect(new Set(modelRows.map((line) => line.indexOf("runs"))).size).toBe(1);
    expect(new Set(modelRows.map((line) => line.indexOf("tokens"))).size).toBe(1);
  });
});

function createUsageSummary(): KanaUsageSummary {
  return {
    scope: "global",
    runCount: 2355,
    mainRunCount: 2296,
    memoryRunCount: 65,
    usage: {
      promptTokens: 155_462_545,
      completionTokens: 2_170_895,
      totalTokens: 157_633_440,
      promptCacheHitTokens: 136_807_808,
      promptCacheMissTokens: 18_654_737,
      reasoningTokens: 1_241_254,
    },
    outcomes: {
      stop: 2065,
      length: 1,
      aborted: 190,
      error: 0,
      turn_limit: 0,
      updated: 0,
      unchanged: 0,
    },
    agents: {
      main: {
        runCount: 2296,
        usage: { promptTokens: 148_000_000, completionTokens: 2_000_000, totalTokens: 150_000_000 },
      },
      memoryAutomatic: {
        runCount: 57,
        usage: { promptTokens: 6_900_000, completionTokens: 100_000, totalTokens: 7_000_000 },
      },
      memoryManual: {
        runCount: 8,
        usage: { promptTokens: 562_545, completionTokens: 70_895, totalTokens: 633_440 },
      },
    },
    models: [
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        runCount: 1768,
        usage: { promptTokens: 128_000_000, completionTokens: 2_000_000, totalTokens: 130_000_000 },
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        runCount: 389,
        usage: { promptTokens: 26_000_000, completionTokens: 1_000_000, totalTokens: 27_000_000 },
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        runCount: 22,
        usage: { promptTokens: 600_000, completionTokens: 33_440, totalTokens: 633_440 },
      },
    ],
  };
}
