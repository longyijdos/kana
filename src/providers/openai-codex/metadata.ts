import type { ModelMetadata } from "@/core";

export type OpenAICodexModelMetadata = ModelMetadata;

export const OPENAI_CODEX_MODELS = {
  "gpt-5.6-sol": {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    // ChatGPT subscription usage is quota-based rather than metered through
    // Kana, so monetary accounting must not apply Platform API pricing.
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 372_000,
    maxOutputTokens: 128_000,
    supportsParallelToolCalls: true,
  },
  "gpt-5.6-terra": {
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 372_000,
    maxOutputTokens: 128_000,
    supportsParallelToolCalls: true,
  },
  "gpt-5.6-luna": {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 372_000,
    maxOutputTokens: 128_000,
    supportsParallelToolCalls: true,
  },
} as const satisfies Record<string, OpenAICodexModelMetadata>;

export function getOpenAICodexModelMetadata(model: string): OpenAICodexModelMetadata {
  const metadata = OPENAI_CODEX_MODELS[model as keyof typeof OPENAI_CODEX_MODELS];
  if (!metadata) {
    throw new Error(`Unsupported OpenAI Codex model: ${model}`);
  }
  return metadata;
}
