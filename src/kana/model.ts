import type { Model } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import { getModel, type OpenAICodexCredentialProvider, OpenAICompatibleModel } from "@/providers";
import { KanaOpenAICodexAuth } from "./auth/openai-codex";
import { getKanaConfigPaths, type ResolvedKanaModelConfig } from "./config";

export type CreateKanaModelOptions = {
  openAICodexCredentialProvider?: OpenAICodexCredentialProvider;
  env?: NodeJS.ProcessEnv;
};

export function createKanaModel(
  config: ResolvedKanaModelConfig,
  logger?: Logger,
  options: CreateKanaModelOptions = {},
): Model {
  const env = options.env ?? process.env;
  switch (config.provider) {
    case "deepseek": {
      const apiKey = env[config.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `Missing ${config.apiKeyEnv}. Set it in your environment or update ${getKanaConfigPaths(env).configPath}.`,
        );
      }

      return getModel({
        provider: "deepseek",
        model: config.model,
        apiKey,
        reasoningEffort: config.reasoningEffort,
        webSearch: config.webSearch,
        imageInput: config.imageInput,
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        logger,
      });
    }
    case "openai-codex": {
      const credentialProvider =
        options.openAICodexCredentialProvider ??
        new KanaOpenAICodexAuth({
          getLogger: () => logger ?? createNoopLogger(),
        });

      return getModel({
        provider: "openai-codex",
        model: config.model,
        credentialProvider,
        reasoningEffort: config.reasoningEffort,
        reasoningSummary: config.reasoningSummary,
        webSearch: config.webSearch,
        imageInput: config.imageInput,
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        logger,
      });
    }
    case "custom": {
      try {
        const apiKey = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
        if (config.apiKeyEnv && !apiKey) {
          throw new Error(
            `Missing ${config.apiKeyEnv}. Set it in your environment or update ${config.providerConfigPath}.`,
          );
        }

        return new OpenAICompatibleModel({
          provider: "custom",
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey,
          metadata: config.metadata,
          reasoningEffort: config.reasoningEffort,
          maxOutputTokens: config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
          logger,
        });
      } catch (error) {
        logger?.error("custom_provider.initialization_failed", {
          component: "custom_provider",
          phase: "initialize",
          errorCode: "CUSTOM_PROVIDER_INITIALIZATION_ERROR",
          errorType: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    }
  }
}
