import type { ModelReasoningMetadata } from "@/core";
import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "@/providers";
import type { KanaConfig, KanaModelProvider } from "./config";
import { KANA_BUILT_IN_MODEL_PROVIDERS, type KanaCustomModelProvider } from "./config/contracts";
import {
  getKanaCustomProviderEntry,
  type KanaCustomProviderSnapshot,
  loadKanaCustomProviderSnapshot,
} from "./custom-provider";

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

const KANA_MODEL_PROVIDER_OPTIONS = KANA_BUILT_IN_MODEL_PROVIDERS.map((provider) => ({
  value: provider,
  label: provider === "deepseek" ? "DeepSeek" : "OpenAI Codex",
}));

export function getKanaModelManagement(
  config: KanaConfig,
  env: NodeJS.ProcessEnv = process.env,
  customProviderSnapshot?: KanaCustomProviderSnapshot,
): KanaModelManagement {
  const snapshot = customProviderSnapshot ?? loadKanaCustomProviderSnapshot(env);
  const activeProvider = config.agent.model.provider;
  const providers: KanaModelManagement["providers"][number][] = [...KANA_MODEL_PROVIDER_OPTIONS];
  const model: KanaModelManagement["model"] = {
    deepseek: createManagedProvider("deepseek", toManagedModels(DEEPSEEK_MODELS), config),
    "openai-codex": createManagedProvider(
      "openai-codex",
      toManagedModels(OPENAI_CODEX_MODELS),
      config,
    ),
  };
  const customIds = new Set(snapshot.entries.keys());
  if (activeProvider !== "deepseek" && activeProvider !== "openai-codex") {
    customIds.add(activeProvider);
  }
  for (const id of customIds) {
    providers.push({ value: id, label: `Custom · ${id.slice("custom:".length)}` });
    model[id] = createManagedCustomProvider(id, config, snapshot);
  }
  return { activeProvider, providers, model };
}

function createManagedCustomProvider(
  id: KanaCustomModelProvider,
  config: KanaConfig,
  snapshot: KanaCustomProviderSnapshot,
): KanaManagedProvider {
  const { provider, error } = getKanaCustomProviderEntry(snapshot, id);
  const available =
    provider?.models.map((model) => ({
      name: model.name,
      reasoning: model.metadata.reasoning,
      supportsImageInput: model.metadata.supportsImageInput,
    })) ?? [];
  return createManagedProvider(id, available, config, error?.message);
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
    Record<string, { reasoning?: ModelReasoningMetadata; supportsImageInput: boolean }>
  >,
): KanaManagedModel[] {
  return Object.entries(models).map(([name, metadata]) => ({
    name,
    reasoning: metadata.reasoning,
    supportsImageInput: metadata.supportsImageInput,
  }));
}
