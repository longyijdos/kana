import type { ModelReasoningMetadata } from "@/core";
import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "@/providers";
import { KANA_MODEL_PROVIDERS, type KanaConfig, type KanaModelProvider } from "./config";
import { type KanaCustomProviderSnapshot, loadKanaCustomProviderSnapshot } from "./custom-provider";
import { getKanaConfigPaths } from "./path";

type KanaManagedModel = {
  name: string;
  reasoning?: ModelReasoningMetadata;
  supportsImageInput: boolean;
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
  config: KanaConfig,
  env: NodeJS.ProcessEnv = process.env,
  customProviderSnapshot?: KanaCustomProviderSnapshot,
): KanaModelManagement {
  const customProviderPath = getKanaConfigPaths(env).customProviderPath;
  const customProvider =
    customProviderSnapshot ?? loadKanaCustomProviderSnapshot(customProviderPath);

  const selection = config.agent.model;
  const models: Record<KanaModelProvider, KanaManagedModel[]> = {
    deepseek: toManagedModels(DEEPSEEK_MODELS),
    "openai-codex": toManagedModels(OPENAI_CODEX_MODELS),
    custom:
      customProvider.provider?.models.map((model) => ({
        name: model.name,
        reasoning: model.metadata.reasoning,
        supportsImageInput: model.metadata.supportsImageInput === true,
      })) ?? [],
  };

  return {
    activeProvider: selection.provider,
    providers: KANA_MODEL_PROVIDER_OPTIONS,
    model: {
      deepseek: createManagedProvider("deepseek", models.deepseek, config),
      "openai-codex": createManagedProvider("openai-codex", models["openai-codex"], config),
      custom: createManagedProvider("custom", models.custom, config, customProvider.error?.message),
    },
  };
}

function createManagedProvider(
  provider: KanaModelProvider,
  available: KanaManagedModel[],
  config: KanaConfig,
  error?: string,
): KanaManagedProvider {
  const active = config.agent.model.provider === provider;
  const name = active ? config.agent.model.name : (available[0]?.name ?? "");
  const selected = available.find((model) => model.name === name);
  const configuredEffort = active ? config.agent.model.reasoningEffort : undefined;
  const reasoningEffort = selected?.reasoning
    ? (configuredEffort ?? selected.reasoning.defaultEffort)
    : undefined;

  return {
    available,
    name,
    reasoningEffort,
    imageInputEnabled: config.agent.imageInput && selected?.supportsImageInput === true,
    error,
  };
}

function toManagedModels(
  models: Readonly<
    Record<string, { reasoning?: ModelReasoningMetadata; supportsImageInput?: boolean }>
  >,
): KanaManagedModel[] {
  return Object.entries(models).map(([name, metadata]) => ({
    name,
    reasoning: metadata.reasoning,
    supportsImageInput: metadata.supportsImageInput === true,
  }));
}
