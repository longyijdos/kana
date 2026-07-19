import { padRightAnsi, renderHighlightedLine, visibleWidth, wrapPlainText } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";

const PREFIX = "> ";

export class UserMessageBlock implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly text: string) {}

  render(width: number, _availableHeight?: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const frameWidth = Math.max(width, 8);
    const contentWidth = Math.max(1, frameWidth - 4);
    const prefixWidth = visibleWidth(PREFIX);
    const messageLines = wrapPlainText(this.text, Math.max(1, contentWidth - prefixWidth));
    const lines = [
      "",
      `+${"-".repeat(frameWidth - 2)}+`,
      ...messageLines.map((line, index) =>
        this.renderRow(
          [
            {
              text: index === 0 ? PREFIX : " ".repeat(prefixWidth),
              color: index === 0 ? tuiTheme.user : undefined,
            },
            { text: line, color: tuiTheme.userMessageText },
          ],
          contentWidth,
        ),
      ),
      `+${"-".repeat(frameWidth - 2)}+`,
      "",
    ];

    this.cachedWidth = width;
    this.cachedLines = lines;

    return lines;
  }

  private renderRow(
    tokens: Parameters<typeof renderHighlightedLine>[0],
    contentWidth: number,
  ): string {
    const content = renderHighlightedLine(tokens);

    return `| ${padRightAnsi(content, contentWidth)} |`;
  }
}
