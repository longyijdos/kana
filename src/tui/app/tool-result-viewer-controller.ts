import {
  type Editor,
  ToolCallBlock,
  type ToolResultView,
  ToolResultViewer,
  type Transcript,
} from "../components";
import type { Component, Tui } from "../runtime";
import type { AppLayout } from "./app-layout";

export type ToolResultViewerControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
};

export class ToolResultViewerController {
  private activeViewer?: ToolResultViewer;

  constructor(private readonly options: ToolResultViewerControllerOptions) {}

  get active(): boolean {
    return this.activeViewer !== undefined;
  }

  toggleLatest(): boolean {
    if (this.activeViewer) {
      this.close();
      return true;
    }

    return this.openLatest();
  }

  openLatest(): boolean {
    const view = this.findLatestToolResultView();

    if (!view) {
      return false;
    }

    this.close();

    const viewer = new ToolResultViewer(view, {
      onClose: () => this.close(),
    });

    this.activeViewer = viewer;
    this.options.layout.showMain(viewer);
    this.options.tui.setFocus(viewer);
    this.options.tui.requestRender(true);

    return true;
  }

  close(): void {
    if (!this.activeViewer) {
      return;
    }

    this.activeViewer = undefined;
    this.options.layout.showTranscript();
    this.options.tui.setFocus(this.options.editor);
    this.options.tui.requestRender(true);
  }

  private findLatestToolResultView(): ToolResultView | undefined {
    const latestTool = this.findLatestTool();

    if (!latestTool?.hasExpandableOutput()) {
      return undefined;
    }

    return latestTool.getResultView();
  }

  private findLatestTool(): ToolCallBlock | undefined {
    for (let index = this.options.transcript.children.length - 1; index >= 0; index -= 1) {
      const child: Component = this.options.transcript.children[index];

      if (child instanceof ToolCallBlock) {
        return child;
      }
    }

    return undefined;
  }
}
