import {
  type Color,
  color,
  renderLatex,
  splitLines,
  truncateToWidth,
  visibleWidth,
} from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { type HighlightedCodeLine, highlightCodeSync } from "../../utils/syntax-highlighter";
import { renderWrappedInline, styleSpans, wrapPlainLine, wrapSpans } from "./markdown-inline";
import { type BlockLatexToken, readBlockLatex } from "./markdown-latex";
import { parseMarkdownTable, renderMarkdownTable } from "./markdown-table";

type MarkdownBlockOptions = {
  color?: Color;
  complete?: boolean;
  hyperlinks?: boolean;
  renderLatex?: boolean;
  trailingLineComplete?: boolean;
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

  render(width: number, _availableHeight?: number): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedText === this.text) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    let codeBlock: { language?: string; lines: string[] } | undefined;

    const sourceLines = splitLines(this.text);
    const lastLineComplete =
      this.options.complete !== false ||
      this.options.trailingLineComplete === true ||
      /(?:\r\n|\r|\n)$/.test(this.text);

    for (let index = 0; index < sourceLines.length; index += 1) {
      const rawLine = sourceLines[index] ?? "";
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

      const latexBlock = readBlockLatex(sourceLines, index);
      if (latexBlock) {
        lines.push(...this.renderLatexBlock(latexBlock, width));
        index = latexBlock.nextLine - 1;
        continue;
      }

      const table = parseMarkdownTable(sourceLines, index, lastLineComplete);
      if (table) {
        lines.push(
          ...renderMarkdownTable(table.table, width, {
            color: this.options.color,
            hyperlinks: this.options.hyperlinks,
            renderLatex: this.options.renderLatex,
          }),
        );
        index = table.nextLine - 1;
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
        hyperlinks: this.options.hyperlinks,
        renderLatex: this.options.renderLatex,
      });
    }

    const thematicBreak = line.match(/^\s*([-*_])(?:\s*\1){2,}\s*$/);
    if (thematicBreak) {
      return [color("-".repeat(Math.min(Math.max(1, width), 40)), tuiTheme.markdownRule)];
    }

    const quote = parseQuote(line);
    if (quote) {
      const prefix = "> ".repeat(quote.level);

      return renderWrappedInline(quote.content, width, {
        defaultColor: tuiTheme.markdownQuote,
        hyperlinks: this.options.hyperlinks,
        prefix,
        renderLatex: this.options.renderLatex,
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
        hyperlinks: this.options.hyperlinks,
        prefix,
        renderLatex: this.options.renderLatex,
        continuationPrefix: " ".repeat(visibleWidth(prefix)),
      });
    }

    const unorderedList = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (unorderedList) {
      const indent = unorderedList[1] ?? "";
      const prefix = `${indent}- `;

      return renderWrappedInline(unorderedList[2] ?? "", width, {
        defaultColor: this.options.color ?? tuiTheme.markdownText,
        hyperlinks: this.options.hyperlinks,
        prefix,
        renderLatex: this.options.renderLatex,
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
        hyperlinks: this.options.hyperlinks,
        prefix,
        renderLatex: this.options.renderLatex,
        continuationPrefix: " ".repeat(visibleWidth(prefix)),
      });
    }

    return renderWrappedInline(normalizeHtmlLine(line), width, {
      defaultColor: this.options.color ?? tuiTheme.markdownText,
      hyperlinks: this.options.hyperlinks,
      renderLatex: this.options.renderLatex,
    });
  }

  private renderLatexBlock(token: BlockLatexToken, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rendered =
      token.pending || this.options.renderLatex === false
        ? undefined
        : renderLatex(token.text, { display: true });
    const output = rendered ?? token.raw.trim();

    return splitLines(output).flatMap((line) =>
      wrapPlainLine(line, safeWidth).map((wrapped) =>
        truncateToWidth(color(wrapped, this.options.color ?? tuiTheme.markdownText), safeWidth, ""),
      ),
    );
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
  const normalized = value
    .replace(/<kbd>(.*?)<\/kbd>/gi, "[$1]")
    .replace(/<summary>(.*?)<\/summary>/gi, "$1")
    .replace(/<\/?(?:details|summary)[^>]*>/gi, "");

  return stripHtmlTags(normalized);
}

const HTML_TAG_PATTERN = /<\/?([a-z][a-z0-9-]*)(?:\s+[^<>]*?)?\s*\/?>/gi;
const HTML_CLOSING_TAG_PATTERN = /<\/([a-z][a-z0-9-]*)\s*>/gi;
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function stripHtmlTags(value: string): string {
  const pairedTagNames = new Set(
    Array.from(value.matchAll(HTML_CLOSING_TAG_PATTERN), (match) => (match[1] ?? "").toLowerCase()),
  );

  // A lone <name> is common programming syntax. Treat it as HTML only when a
  // matching closing tag exists, or when it is a standard void element.
  return value.replace(HTML_TAG_PATTERN, (tag, name: string) => {
    const normalizedName = name.toLowerCase();

    return pairedTagNames.has(normalizedName) || HTML_VOID_TAGS.has(normalizedName) ? "" : tag;
  });
}
