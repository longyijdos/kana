import type {
  KanaConfig,
  KanaDeepSeekModelConfig,
  KanaModelManagement,
  KanaOpenAICodexModelConfig,
} from "@/kana";

export type TuiModelSettings = KanaModelManagement;

export type TuiModelSelection =
  | {
      provider: "deepseek";
      model: string;
      thinking: boolean;
      reasoningEffort: KanaDeepSeekModelConfig["reasoningEffort"];
    }
  | {
      provider: "openai-codex";
      model: string;
      reasoningEffort: KanaOpenAICodexModelConfig["reasoningEffort"];
    };

export function applyTuiModelSelection(config: KanaConfig, selection: TuiModelSelection): void {
  config.provider.active = selection.provider;

  if (selection.provider === "deepseek") {
    config.model.deepseek.name = selection.model;
    config.model.deepseek.thinking = selection.thinking;
    config.model.deepseek.reasoningEffort = selection.reasoningEffort;
    return;
  }

  config.model["openai-codex"].name = selection.model;
  config.model["openai-codex"].reasoningEffort = selection.reasoningEffort;
}

export function formatTuiReasoningSelection(selection: TuiModelSelection): string {
  return selection.provider === "deepseek" && !selection.thinking
    ? "off"
    : selection.reasoningEffort;
}
