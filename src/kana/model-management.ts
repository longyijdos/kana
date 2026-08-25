import type { ModelReasoningMetadata } from "@/core";
import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "@/providers";
import {
  getKanaConfigPaths,
  KANA_MODEL_PROVIDERS,
  type KanaModelProvider,
  type ResolvedKanaConfig,
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

export function getKanaModelManagement(
  config: ResolvedKanaConfig,
  env: NodeJS.ProcessEnv = process.env,
): KanaModelManagement {
  const customProviderPath = getKanaConfigPaths(env).customProviderPath;
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
  const active = config.agent.model;
  const customName = active.provider === "custom" ? active.model : customModels[0]?.name;
  const selectedCustomModel = customProvider?.models.find((model) => model.name === customName);
  const customReasoning =
    active.provider === "custom"
      ? active.reasoningEffort
      : selectedCustomModel
        ? resolveKanaCustomReasoning(selectedCustomModel)
        : undefined;
  const deepSeekName =
    active.provider === "deepseek" ? active.model : (Object.keys(DEEPSEEK_MODELS)[0] ?? "");
  const openAICodexName =
    active.provider === "openai-codex" ? active.model : (Object.keys(OPENAI_CODEX_MODELS)[0] ?? "");
  const deepSeekConfig = config.model.deepseek[deepSeekName];
  const openAICodexConfig = config.model["openai-codex"][openAICodexName];

  return {
    activeProvider: active.provider,
    providers: KANA_MODEL_PROVIDER_OPTIONS,
    model: {
      deepseek: {
        available: toManagedModels(DEEPSEEK_MODELS, config.model.deepseek),
        name: deepSeekName,
        reasoningEffort:
          active.provider === "deepseek" ? active.reasoningEffort : deepSeekConfig?.reasoningEffort,
        imageInputEnabled:
          active.provider === "deepseek"
            ? active.imageInput
            : DEEPSEEK_MODELS[deepSeekName as keyof typeof DEEPSEEK_MODELS]?.supportsImageInput ===
                true && deepSeekConfig?.imageInput !== false,
      },
      "openai-codex": {
        available: toManagedModels(OPENAI_CODEX_MODELS, config.model["openai-codex"]),
        name: openAICodexName,
        reasoningEffort:
          active.provider === "openai-codex"
            ? active.reasoningEffort
            : openAICodexConfig?.reasoningEffort,
        imageInputEnabled:
          active.provider === "openai-codex"
            ? active.imageInput
            : OPENAI_CODEX_MODELS[openAICodexName as keyof typeof OPENAI_CODEX_MODELS]
                ?.supportsImageInput === true && openAICodexConfig?.imageInput !== false,
      },
      custom: {
        available: customModels,
        name: customName ?? "",
        reasoningEffort: customReasoning,
        imageInputEnabled:
          active.provider === "custom"
            ? active.imageInput
            : selectedCustomModel?.metadata.supportsImageInput === true,
        error: customProviderError,
      },
    },
  };
}

function toManagedModels(
  models: Readonly<Record<string, { reasoning?: ModelReasoningMetadata }>>,
  configs: Readonly<Record<string, { reasoningEffort: string }>>,
): KanaManagedModel[] {
  return Object.entries(models).map(([name, metadata]) => {
    const effort = configs[name]?.reasoningEffort;
    return {
      name,
      ...(metadata.reasoning
        ? {
            reasoning: {
              ...metadata.reasoning,
              defaultEffort:
                effort && metadata.reasoning.efforts.includes(effort)
                  ? effort
                  : metadata.reasoning.efforts[0],
            },
          }
        : {}),
    };
  });
}
