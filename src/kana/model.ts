import type { Model } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import {
  DEEPSEEK_MODELS,
  getModel,
  OPENAI_CODEX_MODELS,
  type OpenAICodexCredentialProvider,
  OpenAICompatibleModel,
} from "@/providers";
import { KanaOpenAICodexAuth } from "./auth/openai-codex";
import { getKanaConfigPaths, type KanaConfig } from "./config";
import {
  getKanaCustomProviderModel,
  loadKanaCustomProvider,
  resolveKanaCustomReasoning,
} from "./custom-provider";

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
      const metadata = DEEPSEEK_MODELS[model.name as keyof typeof DEEPSEEK_MODELS];
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
        reasoningEffort: metadata?.reasoning ? model.reasoningEffort : undefined,
        webSearch: model.webSearch,
        imageInput: model.imageInput,
        maxTokens: model.maxTokens,
        timeoutMs: model.timeoutMs,
        maxRetries: model.maxRetries,
        logger,
      });
    }
    case "openai-codex": {
      const model = config.model["openai-codex"];
      const metadata = OPENAI_CODEX_MODELS[model.name as keyof typeof OPENAI_CODEX_MODELS];
      const credentialProvider =
        options.openAICodexCredentialProvider ??
        new KanaOpenAICodexAuth({
          getLogger: () => logger ?? createNoopLogger(),
        });

      return getModel({
        provider: "openai-codex",
        model: model.name,
        credentialProvider,
        reasoningEffort: metadata?.reasoning ? model.reasoningEffort : undefined,
        reasoningSummary: model.reasoningSummary,
        webSearch: model.webSearch,
        imageInput: model.imageInput,
        maxTokens: model.maxTokens,
        timeoutMs: model.timeoutMs,
        maxRetries: model.maxRetries,
        logger,
      });
    }
    case "custom": {
      const paths = getKanaConfigPaths();
      try {
        const provider = loadKanaCustomProvider(paths.customProviderPath);
        const configured = config.model.custom;
        const model = getKanaCustomProviderModel(provider, configured.name);
        const reasoning = resolveKanaCustomReasoning(model, configured.reasoningEffort);
        const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
        if (provider.apiKeyEnv && !apiKey) {
          throw new Error(
            `Missing ${provider.apiKeyEnv}. Set it in your environment or update ${paths.customProviderPath}.`,
          );
        }

        return new OpenAICompatibleModel({
          provider: "custom",
          model: model.name,
          baseUrl: provider.baseUrl,
          apiKey,
          metadata: model.metadata,
          reasoningEffort: reasoning,
          maxTokens: model.metadata.maxOutputTokens,
          timeoutMs: provider.timeoutMs,
          maxRetries: provider.maxRetries,
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
