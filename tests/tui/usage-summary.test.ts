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
    expect(runRows.map((line) => line.indexOf("¥"))).toEqual([20, 20, 20]);
    expect(runRows).toEqual([
      "Main          2296  ¥24.2819",
      "Memory auto     57  ¥0.4573",
      "Memory manual    8  ¥0.0835",
    ]);

    const modelRows = rendered.filter((line) => line.includes(" runs  ¥"));
    expect(modelRows).toHaveLength(3);
    expect(new Set(modelRows.map((line) => line.indexOf("runs"))).size).toBe(1);
    expect(new Set(modelRows.map((line) => line.indexOf("¥"))).size).toBe(1);
  });
});

function createUsageSummary(): KanaUsageSummary {
  return {
    scope: "global",
    runCount: 2355,
    mainRunCount: 2296,
    memoryRunCount: 65,
    costCny: 24.8228,
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
      main: { runCount: 2296, costCny: 24.2819 },
      memoryAutomatic: { runCount: 57, costCny: 0.4573 },
      memoryManual: { runCount: 8, costCny: 0.0835 },
    },
    models: [
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        runCount: 1768,
        costCny: 21.3522,
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        runCount: 389,
        costCny: 3.4705,
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        runCount: 22,
        costCny: 0,
      },
    ],
  };
}
