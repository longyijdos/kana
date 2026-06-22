import type { Model } from "@/core";
import type { Logger } from "@/logging";
import { getModel } from "@/providers";
import { getKanaConfigPaths, type KanaConfig } from "./config";

export function createKanaModel(config: KanaConfig, logger?: Logger): Model {
  const apiKey = process.env[config.model.apiKeyEnv];

  if (!apiKey) {
    throw new Error(
      `Missing ${config.model.apiKeyEnv}. Set it in your environment or update ${getKanaConfigPaths().configPath}.`,
    );
  }

  return getModel({
    provider: config.model.provider,
    model: config.model.name,
    apiKey,
    thinking: config.model.thinking,
    reasoningEffort: config.model.reasoningEffort,
    maxTokens: config.model.maxTokens,
    timeoutMs: config.model.timeoutMs,
    maxRetries: config.model.maxRetries,
    logger,
  });
}
