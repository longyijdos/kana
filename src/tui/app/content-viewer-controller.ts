import { type ContentView, ContentViewer, ToolCallBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import type { AppLayout } from "./app-layout";

export type ContentViewerControllerOptions = {
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  restoreBottom: (focus: boolean) => void;
};

export class ContentViewerController {
  private activeViewer?: ContentViewer;
  // Stable identity of the inspected tool; indexes into the live transcript
  // are re-resolved on every navigation instead of being cached.
  private activeToolId?: string;

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

  // Opens the newest ToolCallBlock in the transcript. Any tool is eligible:
  // short output, missing results, running/canceled tools, read, and
  // custom/unknown tools all open, without consulting expandability or width.
  openLatest(): boolean {
    const block = this.findLatestToolBlock();

    if (!block) {
      return false;
    }

    this.showTool(block);
    return true;
  }

  showPreviousTool(): boolean {
    return this.navigateTool(-1);
  }

  showNextTool(): boolean {
    return this.navigateTool(1);
  }

  open(view: ContentView): void {
    this.close();
    this.activeToolId = undefined;
    this.showViewer(view);
  }

  close(): void {
    if (!this.activeViewer) {
      return;
    }

    const viewer = this.activeViewer;
    const wasVisible = this.options.layout.isBottom(viewer);
    const restoreFocus = this.options.tui.getFocus() === viewer;

    this.activeViewer = undefined;
    this.activeToolId = undefined;

    // A viewer that was already replaced must not overwrite the newer bottom view.
    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
      return;
    }

    this.options.tui.requestRender();
  }

  // Tool-to-tool navigation replaces the bottom viewer directly: the editor
  // must not flash back between tools, and a fresh ContentViewer keeps its
  // own viewport so every tool opens at the top.
  private showTool(block: ToolCallBlock): void {
    this.activeToolId = block.toolCallId;
    this.showViewer(block.getToolDetailView(), {
      onPrevious: () => void this.showPreviousTool(),
      onNext: () => void this.showNextTool(),
    });
  }

  private showViewer(
    view: ContentView,
    options?: { onPrevious?: () => void; onNext?: () => void },
  ): void {
    const viewer = new ContentViewer(view, {
      onClose: () => this.close(),
      ...options,
    });

    this.activeViewer = viewer;
    this.options.layout.showBottom(viewer);
    this.options.tui.setFocus(viewer);
    this.options.tui.requestRender();
  }

  private navigateTool(direction: -1 | 1): boolean {
    if (!this.activeViewer || this.activeToolId === undefined) {
      return false;
    }

    const blocks = this.collectToolBlocks();
    const index = blocks.findIndex((block) => block.toolCallId === this.activeToolId);

    if (index < 0) {
      return false;
    }

    const target = blocks[index + direction];

    if (!target) {
      return false;
    }

    this.showTool(target);
    return true;
  }

  // Every ToolCallBlock participates in navigation: not only expandable ones.
  private collectToolBlocks(): ToolCallBlock[] {
    return this.options.transcript.children.filter(
      (child): child is ToolCallBlock => child instanceof ToolCallBlock,
    );
  }

  private findLatestToolBlock(): ToolCallBlock | undefined {
    return this.collectToolBlocks().at(-1);
  }
}
