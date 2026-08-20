import { describe, expect, test } from "bun:test";
import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "../../src/providers";

describe("provider model metadata", () => {
  test("declares parallel tool-call support per model and transport", () => {
    expect(Object.values(DEEPSEEK_MODELS).map((model) => model.supportsParallelToolCalls)).toEqual([
      true,
      true,
    ]);
    expect(
      Object.values(OPENAI_CODEX_MODELS).map((model) => model.supportsParallelToolCalls),
    ).toEqual([true, true, true]);
  });

  test("declares shared wire protocols and hosted web-search capabilities", () => {
    expect(
      Object.values(DEEPSEEK_MODELS).map((model) => ({
        protocol: model.protocol,
        supportsHostedWebSearch: model.supportsHostedWebSearch,
      })),
    ).toEqual([
      { protocol: "responses", supportsHostedWebSearch: true },
      { protocol: "responses", supportsHostedWebSearch: true },
    ]);
    expect(
      Object.values(OPENAI_CODEX_MODELS).map((model) => ({
        protocol: model.protocol,
        supportsHostedWebSearch: model.supportsHostedWebSearch,
      })),
    ).toEqual([
      { protocol: "responses", supportsHostedWebSearch: true },
      { protocol: "responses", supportsHostedWebSearch: true },
      { protocol: "responses", supportsHostedWebSearch: true },
    ]);
  });

  test("declares model-specific reasoning controls", () => {
    expect(Object.values(DEEPSEEK_MODELS).map((model) => model.reasoning.efforts)).toEqual([
      ["none", "low", "high", "max"],
      ["none", "low", "high", "max"],
    ]);
    expect(Object.values(OPENAI_CODEX_MODELS).map((model) => model.reasoning.efforts)).toEqual([
      ["low", "medium", "high", "xhigh", "max"],
      ["low", "medium", "high", "xhigh", "max"],
      ["low", "medium", "high", "xhigh", "max"],
    ]);
  });
});
