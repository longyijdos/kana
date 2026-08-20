import {
  KANA_DEEPSEEK_REASONING_EFFORTS,
  KANA_OPENAI_CODEX_REASONING_EFFORTS,
  type KanaConfig,
  type KanaDeepSeekModelConfig,
  type KanaModelManagement,
  type KanaModelProvider,
  type KanaOpenAICodexModelConfig,
} from "@/kana";

export type TuiModelSettings = KanaModelManagement;

export type TuiModelSelection = {
  provider: KanaModelProvider;
  model: string;
  reasoningEffort?: string;
};

export function applyTuiModelSelection(config: KanaConfig, selection: TuiModelSelection): void {
  config.provider.active = selection.provider;

  switch (selection.provider) {
    case "deepseek": {
      config.model.deepseek.name = selection.model;
      if (selection.reasoningEffort === undefined) {
        return;
      }
      const effort = requireReasoningEffort(
        selection.reasoningEffort,
        KANA_DEEPSEEK_REASONING_EFFORTS,
        "DeepSeek",
      );
      config.model.deepseek.reasoningEffort = effort as KanaDeepSeekModelConfig["reasoningEffort"];
      return;
    }
    case "openai-codex": {
      config.model["openai-codex"].name = selection.model;
      if (selection.reasoningEffort === undefined) {
        return;
      }
      const effort = requireReasoningEffort(
        selection.reasoningEffort,
        KANA_OPENAI_CODEX_REASONING_EFFORTS,
        "OpenAI Codex",
      );
      config.model["openai-codex"].reasoningEffort =
        effort as KanaOpenAICodexModelConfig["reasoningEffort"];
      return;
    }
    case "custom":
      config.model.custom.name = selection.model;
      config.model.custom.reasoningEffort = selection.reasoningEffort;
  }
}

export function formatTuiReasoningSelection(selection: TuiModelSelection): string | undefined {
  if (selection.reasoningEffort === undefined) {
    return undefined;
  }
  return selection.reasoningEffort === "none" ? "off" : selection.reasoningEffort;
}

function requireReasoningEffort(
  effort: string | undefined,
  allowed: readonly string[],
  provider: string,
): string {
  if (!effort || !allowed.includes(effort)) {
    throw new Error(`${provider} reasoning effort must be one of: ${allowed.join(", ")}.`);
  }
  return effort;
}
