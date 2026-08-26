import type { KanaConfig, KanaModelManagement, KanaModelProvider } from "@/kana";

export type TuiModelSettings = KanaModelManagement;

export type TuiModelSelection = {
  provider: KanaModelProvider;
  model: string;
  reasoningEffort?: string;
};

export function applyTuiModelSelection(config: KanaConfig, selection: TuiModelSelection): void {
  config.agent.model.provider = selection.provider;
  config.agent.model.name = selection.model;
  config.agent.model.reasoningEffort = selection.reasoningEffort;
}

export function formatTuiReasoningSelection(selection: TuiModelSelection): string | undefined {
  if (selection.reasoningEffort === undefined) {
    return undefined;
  }
  return selection.reasoningEffort === "none" ? "off" : selection.reasoningEffort;
}
