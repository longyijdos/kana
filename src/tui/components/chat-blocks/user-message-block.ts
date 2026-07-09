import { renderHighlightedLine, visibleWidth, wrapPlainText } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";

const PREFIX = "> ";
const RIGHT_MARGIN = 1;

export class UserMessageBlock implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly text: string) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const safeWidth = Math.max(1, width);
    // Hide the prefix when it would leave no room for both content and the right margin.
    const prefix = safeWidth >= visibleWidth(PREFIX) + 2 ? PREFIX : "";
    const prefixWidth = visibleWidth(prefix);
    const rightMargin = safeWidth > prefixWidth + 1 ? RIGHT_MARGIN : 0;
    const contentWidth = Math.max(1, safeWidth - prefixWidth - rightMargin);
    const messageLines = wrapPlainText(this.text, contentWidth);
    const lines = [
      "",
      this.renderRow([]),
      ...messageLines.map((line, index) =>
        this.renderRow([
          {
            text: index === 0 ? prefix : " ".repeat(prefixWidth),
            color: index === 0 ? tuiTheme.user : undefined,
          },
          { text: line, color: tuiTheme.userMessageText },
        ]),
      ),
      this.renderRow([]),
      "",
    ];

    this.cachedWidth = width;
    this.cachedLines = lines;

    return lines;
  }

  private renderRow(tokens: Parameters<typeof renderHighlightedLine>[0]): string {
    // Erasing to the line end while the background is active fills the viewport
    // without writing padding spaces that could trigger terminal auto-wrap.
    return renderHighlightedLine(tokens, {
      background: tuiTheme.userMessageBackground,
      clearToEnd: true,
    });
  }
}
