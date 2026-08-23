import {
  type Editor,
  ToolCallBlock,
  type ToolHistoryEntry,
  ToolHistoryPicker,
  type ToolHistoryPickerDecision,
  type Transcript,
} from "../components";
import type { Tui } from "../runtime";
import type { AppLayout } from "./app-layout";
import type { ContentViewerController } from "./content-viewer-controller";

export type ToolHistoryControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  contentViewer: ContentViewerController;
  restoreBottom: (focus: boolean) => void;
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
    this.options.layout.showBottom(picker);
    this.options.tui.setFocus(picker);
    this.options.tui.requestRender();
  }

  close(): void {
    if (!this.activePicker) {
      return;
    }

    const wasVisible = this.options.layout.isBottom(this.activePicker);
    const restoreFocus = this.options.tui.getFocus() === this.activePicker;
    this.activePicker = undefined;

    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
    }
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
    const wasVisible = picker !== undefined && this.options.layout.isBottom(picker);
    const hadFocus = picker !== undefined && this.options.tui.getFocus() === picker;
    this.relinquish();

    if (!this.options.contentViewer.openTool(decision.toolCallId) && wasVisible) {
      this.options.restoreBottom(hadFocus);
    }
  }

  // Clears picker ownership without restoring the bottom or touching focus.
  // Used whenever another view replaces the picker directly — the inspector
  // via Enter, or a Ctrl+O takeover — so the controller never tracks a
  // bottom view it no longer owns. The caller keeps the bottom and focus.
  relinquish(): void {
    this.activePicker = undefined;
  }

  // Newest first: the most recent tool call starts selected, mirroring the
  // Ctrl+O fast path. Every ToolCallBlock participates — short or untruncated
  // output, read, empty results, failed, canceled, and custom/unknown tools —
  // without consulting expandability or render state; non-tool transcript
  // children never appear.
  private collectEntries(): ToolHistoryEntry[] {
    const blocks = this.options.transcript.children.filter(
      (child): child is ToolCallBlock => child instanceof ToolCallBlock,
    );

    return blocks.map((block) => block.getToolHistoryEntry()).reverse();
  }
}
