import { color, dim, mapLines, summarizeText, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import {
  isDown,
  isEnd,
  isEscape,
  isHome,
  isLeft,
  isPageDown,
  isPageUp,
  isRight,
  isUp,
} from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const TOOL_RESULT_VIEWER_VISIBLE_LIMIT = 18;
const TOOL_RESULT_VIEWER_RESERVED_ROWS = 6;

export type ContentView = {
  title: string;
  render: (width: number) => string[];
};

export type ContentViewerOptions = {
  onClose: () => void;
  visibleLimit?: number;
};

export class ContentViewer implements Component {
  private readonly viewport: ListViewport;
  private readonly maximumVisibleLines: number;
  private contentLength = 0;

  constructor(
    private readonly view: ContentView,
    private readonly options: ContentViewerOptions,
  ) {
    this.maximumVisibleLines = options.visibleLimit ?? TOOL_RESULT_VIEWER_VISIBLE_LIMIT;
    this.viewport = new ListViewport(this.maximumVisibleLines);
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.options.onClose();
      return;
    }

    if (isUp(data)) {
      this.viewport.scroll(-1, this.contentLength);
      return;
    }

    if (isDown(data)) {
      this.viewport.scroll(1, this.contentLength);
      return;
    }

    if (isPageUp(data) || isLeft(data)) {
      this.viewport.page(-1, this.contentLength);
      return;
    }

    if (isPageDown(data) || isRight(data)) {
      this.viewport.page(1, this.contentLength);
      return;
    }

    if (isHome(data)) {
      this.viewport.moveTo(0, this.contentLength);
      return;
    }

    if (isEnd(data)) {
      this.viewport.moveTo(this.contentLength - 1, this.contentLength);
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const content = this.view
      .render(contentWidth)
      .flatMap((line) => mapLines(line, (part) => part));
    this.contentLength = content.length;
    this.viewport.setVisibleLimit(
      visibleLimitForHeight(
        this.maximumVisibleLines,
        availableHeight,
        TOOL_RESULT_VIEWER_RESERVED_ROWS,
      ),
      content.length,
    );
    const window = this.viewport.window(content.length);
    const title = truncateToWidth(
      color(summarizeText(this.view.title), tuiTheme.toolActive),
      width,
    );
    const lines = ["", title];

    if (content.length === 0) {
      lines.push(dim("No output yet."));
      return lines;
    }

    lines.push(dim(`Lines ${window.start + 1}-${window.end} of ${content.length}`));

    if (window.hiddenBefore > 0) {
      lines.push(dim(`... ${window.hiddenBefore} lines above`));
    }

    for (let index = window.start; index < window.end; index += 1) {
      lines.push(truncateToWidth(`  ${content[index] ?? ""}`, width));
    }

    if (window.hiddenAfter > 0) {
      lines.push(dim(`... ${window.hiddenAfter} lines below`));
    }

    lines.push(dim("Esc close  Up/Down scroll  Left/Right page"));

    return lines;
  }
}
