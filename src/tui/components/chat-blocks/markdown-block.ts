import { type Color, color, splitLines, truncateToWidth, visibleWidth } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { type HighlightedCodeLine, highlightCodeSync } from "../../utils/syntax-highlighter";
import { renderWrappedInline, styleSpans, wrapPlainLine, wrapSpans } from "./markdown-inline";

type MarkdownBlockOptions = {
  color?: Color;
};

export class MarkdownBlock implements Component {
  private cachedWidth?: number;
  private cachedText?: string;
  private cachedLines?: string[];

  constructor(
    private text: string,
    private readonly options: MarkdownBlockOptions = {},
  ) {}

  setText(text: string): void {
    this.text = text;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedText = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedText === this.text) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    let codeBlock: { language?: string; lines: string[] } | undefined;

    for (const rawLine of splitLines(this.text)) {
      const fence = rawLine.match(/^\s*```([\w-]+)?\s*$/);

      if (fence) {
        if (codeBlock) {
          lines.push(...this.renderCodeBlock(codeBlock.lines, width, codeBlock.language));
          codeBlock = undefined;
        } else {
          codeBlock = {
            language: fence[1],
            lines: [],
          };
        }
        continue;
      }

      if (codeBlock) {
        codeBlock.lines.push(rawLine);
        continue;
      }

      lines.push(...this.renderMarkdownLine(rawLine, width));
    }

    if (codeBlock) {
      lines.push(...this.renderCodeBlock(codeBlock.lines, width, codeBlock.language));
    }

    const rendered = lines.length ? lines : [""];

    this.cachedWidth = width;
    this.cachedText = this.text;
    this.cachedLines = rendered;

    return rendered;
  }

  private renderMarkdownLine(line: string, width: number): string[] {
    if (!line.trim()) {
      return [""];
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      return renderWrappedInline(heading[2] ?? "", width, {
        defaultColor: this.options.color ?? tuiTheme.markdownHeading,
        forceBold: true,
      });
    }

    const thematicBreak = line.match(/^\s*([-*_])(?:\s*\1){2,}\s*$/);
    if (thematicBreak) {
      return [color("-".repeat(Math.min(Math.max(1, width), 40)), tuiTheme.markdownRule)];
    }

    const tableSeparator = line.match(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/);
    if (tableSeparator) {
      return [];
    }

    const tableRow = line.match(/^\s*\|(.+)\|\s*$/);
    if (tableRow) {
      const cells = (tableRow[1] ?? "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);

      return renderWrappedInline(cells.join("  "), width, {
        defaultColor: this.options.color ?? tuiTheme.markdownTable,
      });
    }

    const quote = parseQuote(line);
    if (quote) {
      const prefix = "> ".repeat(quote.level);

      return renderWrappedInline(quote.content, width, {
        defaultColor: tuiTheme.markdownQuote,
        prefix,
        continuationPrefix: " ".repeat(visibleWidth(prefix)),
      });
    }

    const taskList = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (taskList) {
      const indent = taskList[1] ?? "";
      const checked = taskList[2]?.toLowerCase() === "x" ? "x" : " ";
      const prefix = `${indent}[${checked}] `;

      return renderWrappedInline(taskList[3] ?? "", width, {
        defaultColor: this.options.color ?? tuiTheme.markdownText,
        prefix,
        continuationPrefix: " ".repeat(visibleWidth(prefix)),
      });
    }

    const unorderedList = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (unorderedList) {
      const indent = unorderedList[1] ?? "";
      const prefix = `${indent}- `;

      return renderWrappedInline(unorderedList[2] ?? "", width, {
        defaultColor: this.options.color ?? tuiTheme.markdownText,
        prefix,
        continuationPrefix: " ".repeat(visibleWidth(prefix)),
      });
    }

    const orderedList = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (orderedList) {
      const indent = orderedList[1] ?? "";
      const number = line.trimStart().match(/^(\d+[.)])\s+/)?.[1] ?? "1.";
      const prefix = `${indent}${number} `;

      return renderWrappedInline(orderedList[2] ?? "", width, {
        defaultColor: this.options.color ?? tuiTheme.markdownText,
        prefix,
        continuationPrefix: " ".repeat(visibleWidth(prefix)),
      });
    }

    return renderWrappedInline(normalizeHtmlLine(line), width, {
      defaultColor: this.options.color ?? tuiTheme.markdownText,
    });
  }

  private renderCodeBlock(
    codeLines: string[],
    width: number,
    language: string | undefined,
  ): string[] {
    const rendered: string[] = [];
    const prefix = "    ";
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    const lines = codeLines.length ? codeLines : [""];
    const highlighted = highlightCodeSync(lines.join("\n"), language);

    if (highlighted) {
      return this.renderHighlightedCodeBlock(highlighted, width);
    }

    for (const line of lines) {
      const wrapped = wrapPlainLine(line.replace(/\t/g, "   "), contentWidth);

      for (const [index, wrappedLine] of wrapped.entries()) {
        const codePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
        rendered.push(
          truncateToWidth(
            `${codePrefix}${color(wrappedLine, tuiTheme.markdownCodeBlock)}`,
            width,
            "",
          ),
        );
      }
    }

    return rendered;
  }

  private renderHighlightedCodeBlock(codeLines: HighlightedCodeLine[], width: number): string[] {
    const rendered: string[] = [];
    const prefix = "    ";
    const contentWidth = Math.max(1, width - visibleWidth(prefix));

    for (const line of codeLines.length ? codeLines : [[]]) {
      const spans = line.length
        ? line.map((token) => {
            const style = token.color ? { color: token.color } : undefined;

            return {
              text: token.text.replace(/\t/g, "   "),
              style,
            };
          })
        : [{ text: "" }];
      const wrapped = wrapSpans(spans, contentWidth, contentWidth);

      for (const [index, wrappedLine] of wrapped.entries()) {
        const codePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
        rendered.push(truncateToWidth(`${codePrefix}${styleSpans(wrappedLine, {})}`, width, ""));
      }
    }

    return rendered;
  }
}

function parseQuote(line: string): { level: number; content: string } | undefined {
  const trimmed = line.trimStart();
  const quote = trimmed.match(/^((?:>\s*)+)(.*)$/);

  if (!quote) {
    return undefined;
  }

  return {
    level: (quote[1]?.match(/>/g) ?? []).length,
    content: quote[2] ?? "",
  };
}

function normalizeHtmlLine(value: string): string {
  return value
    .replace(/<kbd>(.*?)<\/kbd>/gi, "[$1]")
    .replace(/<summary>(.*?)<\/summary>/gi, "$1")
    .replace(/<\/?(?:details|summary)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
}
