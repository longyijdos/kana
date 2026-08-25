import type { KanaMainAgentModelSelection, KanaModelManagement, KanaModelProvider } from "@/kana";

export type TuiModelSettings = KanaModelManagement;

export type TuiModelSelection = {
  provider: KanaModelProvider;
  model: string;
  reasoningEffort?: string;
};

export function resolveTuiModelSelection(
  selection: TuiModelSelection,
): KanaMainAgentModelSelection {
  return { ...selection };
}

export function formatTuiReasoningSelection(selection: TuiModelSelection): string | undefined {
  if (selection.reasoningEffort === undefined) {
    return undefined;
  }
  return selection.reasoningEffort === "none" ? "off" : selection.reasoningEffort;
}
