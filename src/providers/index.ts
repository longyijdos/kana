import { DeepSeekModel, type DeepSeekModelConfig } from "./deepseek";
import { MockModel, type MockModelConfig } from "./mock";
import { OpenAICodexModel, type OpenAICodexModelConfig } from "./openai-codex";

export type { DeepSeekReasoningEffort } from "./deepseek";
export { DEEPSEEK_MODELS } from "./deepseek";
export type {
  OpenAICodexCredentialProvider,
  OpenAICodexCredentials,
  OpenAICodexReasoningEffort,
  OpenAICodexReasoningSummary,
} from "./openai-codex";
export { OPENAI_CODEX_MODELS } from "./openai-codex";

export type ProviderConfigMap = {
  deepseek: DeepSeekModelConfig;
  mock: MockModelConfig;
  "openai-codex": OpenAICodexModelConfig;
};

export type ProviderName = keyof ProviderConfigMap;

export type ProviderModelMap = {
  deepseek: DeepSeekModel;
  mock: MockModel;
  "openai-codex": OpenAICodexModel;
};

const PROVIDERS = ["deepseek", "mock", "openai-codex"] as const satisfies readonly ProviderName[];

const modelFactories = {
  deepseek: (config: DeepSeekModelConfig) => new DeepSeekModel(config),
  mock: (config: MockModelConfig) => new MockModel(config),
  "openai-codex": (config: OpenAICodexModelConfig) => new OpenAICodexModel(config),
} satisfies {
  [TProvider in ProviderName]: (
    config: ProviderConfigMap[TProvider],
  ) => ProviderModelMap[TProvider];
};

export function getModel<TProvider extends ProviderName>(
  config: ProviderConfigMap[TProvider],
): ProviderModelMap[TProvider] {
  // TypeScript cannot correlate indexed factory unions with indexed config
  // unions, so keep the unsafe edge contained in this factory boundary.
  const createModel = modelFactories[config.provider] as unknown as (
    config: ProviderConfigMap[TProvider],
  ) => ProviderModelMap[TProvider];

  return createModel(config);
}

export function hasProvider(provider: string): provider is ProviderName {
  return (PROVIDERS as readonly string[]).includes(provider);
}

export function listProviders(): readonly ProviderName[] {
  return PROVIDERS;
}
