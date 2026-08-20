import type { ModelMetadata } from "@/core";

export type OpenAICodexModelMetadata = ModelMetadata;

export const OPENAI_CODEX_MODELS = {
  "gpt-5.6-sol": {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    protocol: "responses",
    contextWindow: 372_000,
    maxOutputTokens: 128_000,
    supportsParallelToolCalls: true,
    supportsHostedWebSearch: true,
    supportsImageInput: true,
    reasoning: {
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  },
  "gpt-5.6-terra": {
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    protocol: "responses",
    contextWindow: 372_000,
    maxOutputTokens: 128_000,
    supportsParallelToolCalls: true,
    supportsHostedWebSearch: true,
    supportsImageInput: true,
    reasoning: {
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  },
  "gpt-5.6-luna": {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    protocol: "responses",
    contextWindow: 372_000,
    maxOutputTokens: 128_000,
    supportsParallelToolCalls: true,
    supportsHostedWebSearch: true,
    supportsImageInput: true,
    reasoning: {
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  },
} as const satisfies Record<string, OpenAICodexModelMetadata>;

export function getOpenAICodexModelMetadata(model: string): OpenAICodexModelMetadata {
  const metadata = OPENAI_CODEX_MODELS[model as keyof typeof OPENAI_CODEX_MODELS];
  if (!metadata) {
    throw new Error(`Unsupported OpenAI Codex model: ${model}`);
  }
  return metadata;
}
