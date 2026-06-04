import type { ModelCost, ModelMetadata } from "../../core/model";

export type DeepSeekModelCost = ModelCost;

export type DeepSeekModelMetadata = ModelMetadata;

export const DEEPSEEK_MODELS = {
  "deepseek-v4-flash": {
    cost: {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
  "deepseek-v4-pro": {
    cost: {
      input: 0.435,
      output: 0.87,
      cacheRead: 0.003625,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  },
} as const satisfies Record<string, DeepSeekModelMetadata>;

export function getDeepSeekModelMetadata(model: string): DeepSeekModelMetadata {
  const metadata =
    DEEPSEEK_MODELS[model as keyof typeof DEEPSEEK_MODELS];

  if (!metadata) {
    throw new Error(`Unsupported DeepSeek model: ${model}`);
  }

  return metadata;
}
