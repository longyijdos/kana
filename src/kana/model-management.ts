import { DEEPSEEK_MODELS, OPENAI_CODEX_MODELS } from "@/providers";
import {
  KANA_DEEPSEEK_REASONING_EFFORTS,
  KANA_MODEL_PROVIDERS,
  KANA_OPENAI_CODEX_REASONING_EFFORTS,
  type KanaConfig,
  type KanaDeepSeekModelConfig,
  type KanaModelProvider,
  type KanaOpenAICodexModelConfig,
} from "./config";

export type KanaModelManagement = {
  activeProvider: KanaModelProvider;
  providers: readonly {
    value: KanaModelProvider;
    label: string;
  }[];
  model: {
    deepseek: {
      available: readonly string[];
      name: string;
      thinking: boolean;
      reasoningEffort: KanaDeepSeekModelConfig["reasoningEffort"];
      reasoningEfforts: readonly KanaDeepSeekModelConfig["reasoningEffort"][];
      imageInput?: boolean;
    };
    "openai-codex": {
      available: readonly string[];
      name: string;
      reasoningEffort: KanaOpenAICodexModelConfig["reasoningEffort"];
      reasoningEfforts: readonly KanaOpenAICodexModelConfig["reasoningEffort"][];
      imageInput?: boolean;
    };
  };
};

const KANA_MODEL_PROVIDER_OPTIONS = KANA_MODEL_PROVIDERS.map((provider) => ({
  value: provider,
  label: provider === "deepseek" ? "DeepSeek" : "OpenAI Codex",
}));

const KANA_DEEPSEEK_MODELS = Object.keys(DEEPSEEK_MODELS);
const KANA_OPENAI_CODEX_MODELS = Object.keys(OPENAI_CODEX_MODELS);

export function getKanaModelManagement(config: KanaConfig): KanaModelManagement {
  return {
    activeProvider: config.provider.active,
    providers: KANA_MODEL_PROVIDER_OPTIONS,
    model: {
      deepseek: {
        available: KANA_DEEPSEEK_MODELS,
        name: config.model.deepseek.name,
        thinking: config.model.deepseek.thinking,
        reasoningEffort: config.model.deepseek.reasoningEffort,
        reasoningEfforts: KANA_DEEPSEEK_REASONING_EFFORTS,
        imageInput: config.model.deepseek.imageInput,
      },
      "openai-codex": {
        available: KANA_OPENAI_CODEX_MODELS,
        name: config.model["openai-codex"].name,
        reasoningEffort: config.model["openai-codex"].reasoningEffort,
        reasoningEfforts: KANA_OPENAI_CODEX_REASONING_EFFORTS,
        imageInput: config.model["openai-codex"].imageInput,
      },
    },
  };
}
