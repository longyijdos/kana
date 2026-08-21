import type { ModelReasoningMetadata } from "@/core";
import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "@/providers";
import {
  getKanaConfigPaths,
  KANA_MODEL_PROVIDERS,
  type KanaConfig,
  type KanaModelProvider,
} from "./config";
import {
  type KanaCustomProvider,
  loadOptionalKanaCustomProvider,
  resolveKanaCustomReasoning,
} from "./custom-provider";

type KanaManagedModel = {
  name: string;
  reasoning?: ModelReasoningMetadata & {
    defaultEffort: string;
  };
};

type KanaManagedProvider = {
  available: readonly KanaManagedModel[];
  name: string;
  reasoningEffort?: string;
  imageInputEnabled: boolean;
  error?: string;
};

export type KanaModelManagement = {
  activeProvider: KanaModelProvider;
  providers: readonly {
    value: KanaModelProvider;
    label: string;
  }[];
  model: Record<KanaModelProvider, KanaManagedProvider>;
};

const KANA_MODEL_PROVIDER_OPTIONS = KANA_MODEL_PROVIDERS.map((provider) => ({
  value: provider,
  label:
    provider === "deepseek" ? "DeepSeek" : provider === "openai-codex" ? "OpenAI Codex" : "Custom",
}));

export function getKanaModelManagement(config: KanaConfig): KanaModelManagement {
  const customProviderPath = getKanaConfigPaths().customProviderPath;
  let customProvider: KanaCustomProvider | undefined;
  let customProviderError: string | undefined;
  try {
    customProvider = loadOptionalKanaCustomProvider(customProviderPath);
    if (!customProvider) {
      customProviderError = `Custom provider configuration was not found at ${customProviderPath}. Copy custom.example.toml to custom.toml and configure it.`;
    }
  } catch (error) {
    customProviderError =
      error instanceof Error ? error.message : "Could not load Custom provider configuration.";
  }
  const customModels: KanaManagedModel[] =
    customProvider?.models.map((model) => ({
      name: model.name,
      ...(model.metadata.reasoning
        ? {
            reasoning: {
              ...model.metadata.reasoning,
              defaultEffort: model.defaultReasoningEffort ?? model.metadata.reasoning.efforts[0],
            },
          }
        : {}),
    })) ?? [];
  const selectedCustomModel = customProvider?.models.find(
    (model) => model.name === config.model.custom.name,
  );
  const customReasoning = selectedCustomModel
    ? resolveKanaCustomReasoning(selectedCustomModel, config.model.custom.reasoningEffort)
    : undefined;

  return {
    activeProvider: config.provider.active,
    providers: KANA_MODEL_PROVIDER_OPTIONS,
    model: {
      deepseek: {
        available: toManagedModels(DEEPSEEK_MODELS, config.model.deepseek.reasoningEffort),
        name: config.model.deepseek.name,
        reasoningEffort: config.model.deepseek.reasoningEffort,
        imageInputEnabled:
          DEEPSEEK_MODELS[config.model.deepseek.name as keyof typeof DEEPSEEK_MODELS]
            ?.supportsImageInput === true && config.model.deepseek.imageInput !== false,
      },
      "openai-codex": {
        available: toManagedModels(
          OPENAI_CODEX_MODELS,
          config.model["openai-codex"].reasoningEffort,
        ),
        name: config.model["openai-codex"].name,
        reasoningEffort: config.model["openai-codex"].reasoningEffort,
        imageInputEnabled:
          OPENAI_CODEX_MODELS[config.model["openai-codex"].name as keyof typeof OPENAI_CODEX_MODELS]
            ?.supportsImageInput === true && config.model["openai-codex"].imageInput !== false,
      },
      custom: {
        available: customModels,
        name: config.model.custom.name || customModels[0]?.name || "",
        reasoningEffort: customReasoning,
        imageInputEnabled: selectedCustomModel?.metadata.supportsImageInput === true,
        error: customProviderError,
      },
    },
  };
}

function toManagedModels(
  models: Readonly<Record<string, { reasoning?: ModelReasoningMetadata }>>,
  currentEffort: string,
): KanaManagedModel[] {
  return Object.entries(models).map(([name, metadata]) => ({
    name,
    ...(metadata.reasoning
      ? {
          reasoning: {
            ...metadata.reasoning,
            defaultEffort: metadata.reasoning.efforts.includes(currentEffort)
              ? currentEffort
              : metadata.reasoning.efforts[0],
          },
        }
      : {}),
  }));
}
