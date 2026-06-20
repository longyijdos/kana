import {
  type ContentView,
  ContentViewer,
  type Editor,
  ToolCallBlock,
  type Transcript,
} from "../components";
import type { Component, Tui } from "../runtime";
import type { AppLayout } from "./app-layout";

export type ContentViewerControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  focusAfterClose?: () => Component | undefined;
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
    this.options.layout.showMain(viewer);
    this.options.tui.setFocus(viewer);
    this.options.tui.requestRender(true);
  }

  close(): void {
    if (!this.activeViewer) {
      return;
    }

    const restoreEditorFocus = this.options.tui.getFocus() === this.activeViewer;

    this.activeViewer = undefined;
    this.options.layout.showTranscript();

    if (restoreEditorFocus) {
      this.options.tui.setFocus(this.options.focusAfterClose?.() ?? this.options.editor);
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
