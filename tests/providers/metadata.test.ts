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
});
