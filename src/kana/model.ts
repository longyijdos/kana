import type { Model, ModelReasoningMetadata } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import {
  DEEPSEEK_MODELS,
  type DeepSeekReasoningEffort,
  getModel,
  OPENAI_CODEX_MODELS,
  type OpenAICodexCredentialProvider,
  type OpenAICodexReasoningEffort,
  OpenAICompatibleModel,
} from "@/providers";
import { KanaOpenAICodexAuth } from "./auth/openai-codex";
import {
  getKanaConfigPaths,
  type KanaAgentRuntimeConfig,
  type KanaDeepSeekProviderConfig,
  type KanaModelConfig,
  type KanaModelProvider,
  type KanaOpenAICodexProviderConfig,
  type KanaProviderConfig,
} from "./config";
import { getKanaCustomProviderModel, loadKanaCustomProvider } from "./custom-provider";

export type KanaSelectedProviderConfig =
  | { provider: "deepseek"; config: KanaDeepSeekProviderConfig }
  | { provider: "openai-codex"; config: KanaOpenAICodexProviderConfig }
  | { provider: "custom" };

export type CreateKanaModelOptions = {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  openAICodexCredentialProvider?: OpenAICodexCredentialProvider;
};

export type KanaAgentModelRuntime = {
  model: Model;
  webSearch: boolean;
  imageInput: boolean;
  parallelToolCalls: boolean;
  maxOutputTokens: number;
  contextLimit: number;
};

export function createKanaAgentModelRuntime(
  config: KanaAgentRuntimeConfig & { model: KanaModelConfig },
  providers: KanaProviderConfig,
  options: CreateKanaModelOptions = {},
): KanaAgentModelRuntime {
  const model = createKanaModel(
    config.model,
    selectKanaProviderConfig(providers, config.model.provider),
    options,
  );

  return {
    model,
    webSearch: config.webSearch && model.metadata.supportsHostedWebSearch,
    imageInput: config.imageInput && model.metadata.supportsImageInput === true,
    parallelToolCalls: config.parallelToolCalls && model.metadata.supportsParallelToolCalls,
    maxOutputTokens: Math.min(
      config.model.maxOutputTokens ?? model.metadata.maxOutputTokens,
      model.metadata.maxOutputTokens,
    ),
    contextLimit: Math.min(
      config.model.contextLimit ?? model.metadata.contextWindow,
      model.metadata.contextWindow,
    ),
  };
}

export function selectKanaProviderConfig(
  config: KanaProviderConfig,
  provider: KanaModelProvider,
): KanaSelectedProviderConfig {
  switch (provider) {
    case "deepseek":
      return { provider, config: config.deepseek };
    case "openai-codex":
      return { provider, config: config["openai-codex"] };
    case "custom":
      return { provider };
  }
}

export function createKanaModel(
  modelConfig: KanaModelConfig,
  providerConfig: KanaSelectedProviderConfig,
  options: CreateKanaModelOptions = {},
): Model {
  if (modelConfig.provider !== providerConfig.provider) {
    throw new Error(
      `Model provider ${modelConfig.provider} does not match ${providerConfig.provider} configuration.`,
    );
  }

  const env = options.env ?? process.env;
  switch (providerConfig.provider) {
    case "deepseek": {
      const metadata = DEEPSEEK_MODELS[modelConfig.name as keyof typeof DEEPSEEK_MODELS];
      if (!metadata) {
        throw new Error(`Unsupported DeepSeek model: ${modelConfig.name}`);
      }
      const apiKey = env[providerConfig.config.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `Missing ${providerConfig.config.apiKeyEnv}. Set it in your environment or update ${getKanaConfigPaths(env).configPath}.`,
        );
      }
      const reasoningEffort = resolveKanaModelReasoning(
        metadata.reasoning,
        modelConfig.reasoningEffort,
        `DeepSeek model "${modelConfig.name}"`,
      ) as DeepSeekReasoningEffort | undefined;

      return getModel({
        provider: "deepseek",
        model: modelConfig.name,
        apiKey,
        reasoningEffort,
        timeoutMs: providerConfig.config.timeoutMs,
        maxRetries: providerConfig.config.maxRetries,
        logger: options.logger,
      });
    }
    case "openai-codex": {
      const metadata = OPENAI_CODEX_MODELS[modelConfig.name as keyof typeof OPENAI_CODEX_MODELS];
      if (!metadata) {
        throw new Error(`Unsupported OpenAI Codex model: ${modelConfig.name}`);
      }
      const credentialProvider =
        options.openAICodexCredentialProvider ??
        new KanaOpenAICodexAuth({
          env,
          getLogger: () => options.logger ?? createNoopLogger(),
        });
      const reasoningEffort = resolveKanaModelReasoning(
        metadata.reasoning,
        modelConfig.reasoningEffort,
        `OpenAI Codex model "${modelConfig.name}"`,
      ) as OpenAICodexReasoningEffort | undefined;

      return getModel({
        provider: "openai-codex",
        model: modelConfig.name,
        credentialProvider,
        reasoningEffort,
        reasoningSummary: providerConfig.config.reasoningSummary,
        timeoutMs: providerConfig.config.timeoutMs,
        maxRetries: providerConfig.config.maxRetries,
        logger: options.logger,
      });
    }
    case "custom": {
      const paths = getKanaConfigPaths(env);
      try {
        const provider = loadKanaCustomProvider(paths.customProviderPath);
        const model = getKanaCustomProviderModel(provider, modelConfig.name);
        const reasoningEffort = resolveKanaModelReasoning(
          model.metadata.reasoning,
          modelConfig.reasoningEffort,
          `Custom model "${model.name}"`,
        );
        const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
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
          reasoningEffort,
          timeoutMs: provider.timeoutMs,
          maxRetries: provider.maxRetries,
          logger: options.logger,
        });
      } catch (error) {
        options.logger?.error("custom_provider.initialization_failed", {
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

export function resolveKanaModelReasoning(
  reasoning: ModelReasoningMetadata | undefined,
  configuredEffort?: string,
  modelLabel = "Selected model",
): string | undefined {
  if (!reasoning) {
    if (configuredEffort !== undefined) {
      throw new Error(`${modelLabel} does not expose reasoning controls.`);
    }
    return undefined;
  }

  const effort = configuredEffort ?? reasoning.defaultEffort;
  if (!reasoning.efforts.includes(effort)) {
    throw new Error(
      `${modelLabel} reasoning_effort must be one of: ${reasoning.efforts.join(", ")}.`,
    );
  }
  return effort;
}
