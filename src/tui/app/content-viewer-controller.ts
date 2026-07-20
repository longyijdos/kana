import { type ContentView, ContentViewer, ToolCallBlock, type Transcript } from "../components";
import type { Component, Tui } from "../runtime";
import type { AppLayout } from "./app-layout";

export type ContentViewerControllerOptions = {
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  restoreBottom: (focus: boolean) => void;
};

export class ContentViewerController {
  private activeViewer?: ContentViewer;

  constructor(private readonly options: ContentViewerControllerOptions) {}

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

    this.open(view);
    return true;
  }

  open(view: ContentView): void {
    this.close();

    const viewer = new ContentViewer(view, {
      onClose: () => this.close(),
    });

    this.activeViewer = viewer;
    this.options.layout.showBottom(viewer);
    this.options.tui.setFocus(viewer);
    this.options.tui.requestRender(true);
  }

  close(): void {
    if (!this.activeViewer) {
      return;
    }

    const viewer = this.activeViewer;
    const wasVisible = this.options.layout.isBottom(viewer);
    const restoreFocus = this.options.tui.getFocus() === viewer;

    this.activeViewer = undefined;

    // A viewer that was already replaced must not overwrite the newer bottom view.
    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
      return;
    }

    this.options.tui.requestRender(true);
  }

  private findLatestToolResultView(): ContentView | undefined {
    return this.findLatestExpandableTool()?.getResultView();
  }

  private findLatestExpandableTool(): ToolCallBlock | undefined {
    for (let index = this.options.transcript.children.length - 1; index >= 0; index -= 1) {
      const child: Component = this.options.transcript.children[index];

      if (child instanceof ToolCallBlock && child.hasExpandableOutput()) {
        return child;
      }
    }

    return undefined;
  }
}
