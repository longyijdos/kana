import { type ContentView, ContentViewer, ToolCallBlock, type Transcript } from "../components";
import type { BottomAreaController } from "./bottom-area-controller";

export type ContentViewerControllerOptions = {
  bottomArea: BottomAreaController;
  transcript: Transcript;
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

  // Opens the tool call with the given stable id, e.g. picked from the
  // /tools history. Returns false when the transcript no longer contains it.
  // The same id drives [ / ] navigation, so a picker selection lines up with
  // transcript chronology without any index bookkeeping here.
  openTool(toolCallId: string): boolean {
    const block = this.collectToolBlocks().find((candidate) => candidate.toolCallId === toolCallId);

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
    const restoreFocus = this.options.bottomArea.hasFocus(viewer);

    this.activeViewer = undefined;
    this.activeToolId = undefined;
    this.options.bottomArea.restore(viewer, restoreFocus);
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
    this.options.bottomArea.show(viewer);
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
