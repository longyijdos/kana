import { describe, expect, test } from "bun:test";
import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "../../src/providers";

describe("provider model metadata", () => {
  test("declares parallel tool-call support per model and transport", () => {
    expect(Object.values(DEEPSEEK_MODELS).map((model) => model.supportsParallelToolCalls)).toEqual([
      true,
      true,
    ]);
    expect(Object.keys(OPENAI_CODEX_MODELS)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    for (const model of Object.values(OPENAI_CODEX_MODELS)) {
      expect(model.supportsParallelToolCalls).toBe(true);
    }
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
    for (const model of Object.values(OPENAI_CODEX_MODELS)) {
      expect(model).toMatchObject({
        provider: "openai-codex",
        protocol: "responses",
        supportsHostedWebSearch: true,
        supportsImageInput: true,
      });
    }
  });

  test("declares model-specific reasoning controls", () => {
    expect(
      Object.values(DEEPSEEK_MODELS).map((model) => ({
        efforts: model.reasoning.efforts,
        defaultEffort: model.reasoning.defaultEffort,
      })),
    ).toEqual([
      { efforts: ["none", "low", "high", "max"], defaultEffort: "high" },
      { efforts: ["none", "low", "high", "max"], defaultEffort: "high" },
    ]);
    expect(
      Object.fromEntries(
        Object.entries(OPENAI_CODEX_MODELS).map(([name, model]) => [name, model.reasoning]),
      ),
    ).toEqual({
      "gpt-5.6-sol": {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "low",
      },
      "gpt-5.6-terra": {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
      "gpt-5.6-luna": {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
      "gpt-6.1-sol": {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "low",
      },
      "gpt-6-astra": {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "low",
      },
      "gpt-6-sol": {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
      "gpt-6-luna": {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
      },
      "gpt-5.5": { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    });
  });

  test("uses SIWC context ceilings and public model output limits", () => {
    expect(
      Object.values(OPENAI_CODEX_MODELS).map((model) => ({
        model: model.model,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
      })),
    ).toEqual([
      { model: "gpt-6.1-sol", contextWindow: 872_000, maxOutputTokens: 128_000 },
      { model: "gpt-6-astra", contextWindow: 872_000, maxOutputTokens: 128_000 },
      { model: "gpt-6-sol", contextWindow: 872_000, maxOutputTokens: 128_000 },
      { model: "gpt-6-luna", contextWindow: 872_000, maxOutputTokens: 128_000 },
      { model: "gpt-5.6-sol", contextWindow: 872_000, maxOutputTokens: 128_000 },
      { model: "gpt-5.6-terra", contextWindow: 872_000, maxOutputTokens: 128_000 },
      { model: "gpt-5.6-luna", contextWindow: 872_000, maxOutputTokens: 128_000 },
      { model: "gpt-5.5", contextWindow: 272_000, maxOutputTokens: 128_000 },
    ]);
  });
});
