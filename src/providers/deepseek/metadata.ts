import type { ModelMetadata } from "@/core";

export type DeepSeekModelMetadata = ModelMetadata & { protocol: "responses" };

export const DEEPSEEK_MODELS = {
  "deepseek-v4-flash": {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsParallelToolCalls: true,
    protocol: "responses",
    supportsHostedWebSearch: true,
    supportsImageInput: false,
    reasoning: {
      efforts: ["none", "low", "high", "max"],
      defaultEffort: "high",
    },
  },
  "deepseek-v4-flash-vision-exp": {
    provider: "deepseek",
    model: "deepseek-v4-flash-vision-exp",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsParallelToolCalls: true,
    protocol: "responses",
    supportsHostedWebSearch: true,
    supportsImageInput: true,
    reasoning: {
      efforts: ["none", "low", "high", "max"],
      defaultEffort: "high",
    },
  },
  "deepseek-v4-pro": {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    supportsParallelToolCalls: true,
    protocol: "responses",
    supportsHostedWebSearch: true,
    supportsImageInput: false,
    reasoning: {
      efforts: ["none", "low", "high", "max"],
      defaultEffort: "high",
    },
  },
} as const satisfies Record<string, DeepSeekModelMetadata>;

export function getDeepSeekModelMetadata(model: string): DeepSeekModelMetadata {
  const metadata = DEEPSEEK_MODELS[model as keyof typeof DEEPSEEK_MODELS];

  if (!metadata) {
    throw new Error(`Unsupported DeepSeek model: ${model}`);
  }

  return metadata;
}
