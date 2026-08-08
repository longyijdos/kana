import type { Model } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import { getModel, type OpenAICodexCredentialProvider } from "@/providers";
import { KanaOpenAICodexAuth } from "./auth/openai-codex";
import { getKanaConfigPaths, type KanaConfig } from "./config";

export type CreateKanaModelOptions = {
  openAICodexCredentialProvider?: OpenAICodexCredentialProvider;
};

export function createKanaModel(
  config: KanaConfig,
  logger?: Logger,
  options: CreateKanaModelOptions = {},
): Model {
  switch (config.provider.active) {
    case "deepseek": {
      const model = config.model.deepseek;
      const apiKey = process.env[model.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `Missing ${model.apiKeyEnv}. Set it in your environment or update ${getKanaConfigPaths().configPath}.`,
        );
      }

      return getModel({
        provider: "deepseek",
        model: model.name,
        apiKey,
        thinking: model.thinking,
        reasoningEffort: model.reasoningEffort,
        maxTokens: model.maxTokens,
        timeoutMs: model.timeoutMs,
        maxRetries: model.maxRetries,
        logger,
      });
    }
    case "openai-codex": {
      const model = config.model["openai-codex"];
      const credentialProvider =
        options.openAICodexCredentialProvider ??
        new KanaOpenAICodexAuth({
          getLogger: () => logger ?? createNoopLogger(),
        });

      return getModel({
        provider: "openai-codex",
        model: model.name,
        credentialProvider,
        reasoningEffort: model.reasoningEffort,
        reasoningSummary: model.reasoningSummary,
        webSearch: model.webSearch,
        maxTokens: model.maxTokens,
        timeoutMs: model.timeoutMs,
        maxRetries: model.maxRetries,
        logger,
      });
    }
  }
}
