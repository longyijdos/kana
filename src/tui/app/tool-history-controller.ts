import {
  type Editor,
  ToolCallBlock,
  type ToolHistoryEntry,
  ToolHistoryPicker,
  type ToolHistoryPickerDecision,
  type Transcript,
} from "../components";
import type { BottomAreaController } from "./bottom-area-controller";
import type { ContentViewerController } from "./content-viewer-controller";

export type ToolHistoryControllerOptions = {
  editor: Editor;
  bottomArea: BottomAreaController;
  transcript: Transcript;
  contentViewer: ContentViewerController;
};

// /tools: a browsable picker over the current transcript's tool calls. It
// owns snapshotting and selection; the actual Tool Detail Inspector stays in
// ContentViewerController.
export class ToolHistoryController {
  private activePicker?: ToolHistoryPicker;

  constructor(private readonly options: ToolHistoryControllerOptions) {}

  get active(): boolean {
    return this.activePicker !== undefined;
  }

  open(): void {
    this.close();
    this.options.editor.clear();

    // Snapshot at open: later resize, compact-render churn, or new transcript
    // children must not change membership or ordering while the picker is up.
    const entries = this.collectEntries();

    const picker = new ToolHistoryPicker(entries, (decision) => {
      this.finish(decision);
    });

    this.activePicker = picker;
    this.options.bottomArea.show(picker);
  }

  close(): void {
    if (!this.activePicker) {
      return;
    }

    const restoreFocus = this.options.bottomArea.hasFocus(this.activePicker);
    const picker = this.activePicker;
    this.activePicker = undefined;
    this.options.bottomArea.restore(picker, restoreFocus);
  }

  private finish(decision: ToolHistoryPickerDecision): void {
    if (decision.type === "cancel") {
      this.close();
      return;
    }

    // The picker relinquishes the bottom directly to the inspector: no
    // editor intermediate frame, no restore-then-replace layout churn. The
    // inspector only gets the stable id; it re-resolves the block itself.
    const picker = this.activePicker;
    const wasVisible = picker !== undefined && this.options.bottomArea.isShowing(picker);
    const hadFocus = picker !== undefined && this.options.bottomArea.hasFocus(picker);
    this.relinquish();

    if (!this.options.contentViewer.openTool(decision.toolCallId) && wasVisible && picker) {
      this.options.bottomArea.restore(picker, hadFocus);
    }
  }

  // Clears picker ownership without restoring the bottom or touching focus.
  // Used whenever another view replaces the picker directly — the inspector
  // via Enter, or a Ctrl+O takeover — so the controller never tracks a
  // bottom view it no longer owns. The caller keeps the bottom and focus.
  relinquish(): void {
    this.activePicker = undefined;
  }

  // Newest first mirrors Ctrl+O. Include every ToolCallBlock regardless of state,
  // output length, or schema; never include non-tool transcript children.
  private collectEntries(): ToolHistoryEntry[] {
    const blocks = this.options.transcript.children.filter(
      (child): child is ToolCallBlock => child instanceof ToolCallBlock,
    );

    return blocks.map((block) => block.getToolHistoryEntry()).reverse();
  }
}
