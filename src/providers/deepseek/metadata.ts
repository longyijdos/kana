import type { ModelCost, ModelMetadata } from "@/core";

export type DeepSeekModelCost = ModelCost;

export type DeepSeekModelMetadata = ModelMetadata;

export const DEEPSEEK_MODELS = {
  "deepseek-v4-flash": {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
  "deepseek-v4-pro": {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    cost: {
      input: 3,
      output: 6,
      cacheRead: 0.025,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
} as const satisfies Record<string, DeepSeekModelMetadata>;

export function getDeepSeekModelMetadata(model: string): DeepSeekModelMetadata {
  const metadata = DEEPSEEK_MODELS[model as keyof typeof DEEPSEEK_MODELS];

  if (!metadata) {
    throw new Error(`Unsupported DeepSeek model: ${model}`);
  }

  return metadata;
}
