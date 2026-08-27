import type { ModelMetadata } from "@/core";
import type { ConversationRuntime } from "@/kana";
import type { Logger } from "@/logging";
import { type Editor, TextBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { BottomAreaController } from "./bottom-area-controller";
import {
  formatTuiReasoningSelection,
  type TuiModelSelection,
  type TuiModelSettings,
} from "./model-selection";
import type { StatusProjectionController } from "./status-projection-controller";

export type ModelSelectionControllerOptions = {
  conversation: ConversationRuntime<TuiModelSelection>;
  editor: Editor;
  transcript: Transcript;
  tui: Tui;
  bottomArea: BottomAreaController;
  status: StatusProjectionController;
  showError: (error: unknown) => void;
  getLogger: () => Logger;
};

export class ModelSelectionController {
  constructor(private readonly options: ModelSelectionControllerOptions) {}

  switch(selection: TuiModelSelection): void {
    this.options.bottomArea.showFallback();
    const reasoning = formatTuiReasoningSelection(selection);
    const logMetadata = {
      provider: selection.provider,
      model: selection.model,
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
    };
    this.options.getLogger().info("tui.model_switch_started", logMetadata);

    try {
      this.options.conversation.reconfigure(selection);
      this.options.editor.setModel(
        formatModelSelection(this.options.conversation.state.model.metadata, reasoning),
      );
      this.options.status.updateContextUsage();
      this.options.transcript.addChild(
        new TextBlock(
          `Switched to ${formatModelSelection(
            this.options.conversation.state.model.metadata,
            reasoning,
            true,
            true,
          )}.`,
          { color: tuiTheme.muted },
        ),
      );
      this.options.status.update("idle", { activeTool: undefined });
      this.options.getLogger().info("tui.model_switch_completed", logMetadata);
    } catch (error) {
      this.options.getLogger().error("tui.model_switch_failed", {
        ...logMetadata,
        error,
      });
      this.options.showError(error);
    }

    this.options.tui.requestRender();
  }
}

export function formatStatusModel(metadata: ModelMetadata, settings?: TuiModelSettings): string {
  if (!settings || settings.activeProvider !== metadata.provider) {
    return metadata.model;
  }

  const model = settings.model[settings.activeProvider];
  if (model.name !== metadata.model || model.reasoningEffort === undefined) {
    return metadata.model;
  }
  return `${metadata.model} · ${model.reasoningEffort === "none" ? "off" : model.reasoningEffort}`;
}

function formatModelName(metadata: ModelMetadata): string {
  return `${metadata.provider}/${metadata.model}`;
}

function formatModelSelection(
  metadata: ModelMetadata,
  reasoning: string | undefined,
  includeProvider = false,
  labelReasoning = false,
): string {
  const model = includeProvider ? formatModelName(metadata) : metadata.model;
  return reasoning ? `${model} · ${labelReasoning ? "reasoning " : ""}${reasoning}` : model;
}
