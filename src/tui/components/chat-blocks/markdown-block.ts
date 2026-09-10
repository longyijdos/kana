import type { Token, Tokens } from "marked";
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
import {
  renderWrappedInline,
  renderWrappedInlineTokens,
  styleSpans,
  wrapPlainLine,
  wrapSpans,
} from "./markdown-inline";
import { renderMarkdownMermaid } from "./markdown-mermaid";
import { lexMarkdown, type MarkdownBlockLatexToken } from "./markdown-parser";
import { parseMarkdownTable, renderMarkdownTable } from "./markdown-table";

type MarkdownBlockOptions = {
  color?: Color;
  complete?: boolean;
  hyperlinks?: boolean;
  renderLatex?: boolean;
  renderMermaid?: boolean;
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

    const lastLineComplete =
      this.options.complete !== false ||
      this.options.trailingLineComplete === true ||
      /(?:\r\n|\r|\n)$/.test(this.text);
    const tokens = lexMarkdown(this.text);
    const lines = this.renderMarkdownTokens(tokens, width, lastLineComplete);
    if (tokens.at(-1)?.type !== "space" && /(?:\r\n|\r|\n)$/.test(this.text)) {
      lines.push("");
    }

    const rendered = lines.length ? lines : [""];

    this.cachedWidth = width;
    this.cachedText = this.text;
    this.cachedLines = rendered;

    return rendered;
  }

  private renderMarkdownTokens(
    tokens: readonly Token[],
    width: number,
    lastLineComplete: boolean,
    defaultColor: Color = this.options.color ?? tuiTheme.markdownText,
  ): string[] {
    const lines: string[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.type === "space") {
        const lineBreaks = token.raw.match(/\r\n|\r|\n/g)?.length ?? 0;
        // Adjacent blocks already own the two endpoint lines; a leading or
        // trailing whitespace token owns its otherwise missing endpoint.
        const adjoiningBlocks = Number(index > 0) + Number(index + 1 < tokens.length);
        lines.push(
          ...Array.from({ length: Math.max(0, lineBreaks + 1 - adjoiningBlocks) }, () => ""),
        );
        continue;
      }

      lines.push(
        ...this.renderMarkdownToken(
          token,
          width,
          lastLineComplete,
          index === tokens.length - 1,
          defaultColor,
        ),
      );
    }

    return lines;
  }

  private renderMarkdownToken(
    token: Token,
    width: number,
    lastLineComplete: boolean,
    isLast: boolean,
    defaultColor: Color,
  ): string[] {
    switch (token.type) {
      case "paragraph":
        return renderWrappedInlineTokens((token as Tokens.Paragraph).tokens, width, {
          defaultColor,
          hyperlinks: this.options.hyperlinks,
          renderLatex: this.options.renderLatex,
        });

      case "text": {
        const text = token as Tokens.Text;
        return text.tokens
          ? renderWrappedInlineTokens(text.tokens, width, {
              defaultColor,
              hyperlinks: this.options.hyperlinks,
              renderLatex: this.options.renderLatex,
            })
          : renderWrappedInline(text.text, width, {
              defaultColor,
              hyperlinks: this.options.hyperlinks,
              renderLatex: this.options.renderLatex,
            });
      }

      case "heading": {
        const heading = token as Tokens.Heading;
        return renderWrappedInlineTokens(heading.tokens, width, {
          defaultColor: this.options.color ?? tuiTheme.markdownHeading,
          forceBold: true,
          hyperlinks: this.options.hyperlinks,
          renderLatex: this.options.renderLatex,
        });
      }

      case "hr":
        return [color("-".repeat(Math.min(Math.max(1, width), 40)), tuiTheme.markdownRule)];

      case "code": {
        const code = token as Tokens.Code;
        if (code.codeBlockStyle === "indented") {
          // Kana historically recognizes indented headings, quotes, lists,
          // and rules instead of treating the whole region as a code block.
          return splitLines(code.raw.replace(/(?:\r\n|\r|\n)$/, "")).flatMap((line) =>
            this.renderMarkdownLine(line, width),
          );
        }
        return this.renderCodeBlock(splitLines(code.text), width, code.lang);
      }

      case "list":
        return this.renderList(token as Tokens.List, width, "", lastLineComplete, defaultColor);

      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const contentWidth = Math.max(1, width - 2);
        const content = this.renderMarkdownTokens(
          quote.tokens,
          contentWidth,
          lastLineComplete,
          tuiTheme.markdownQuote,
        );
        return content.map((line) => truncateToWidth(`> ${line}`, width, ""));
      }

      case "table": {
        const tableLines = splitLines(token.raw.replace(/(?:\r\n|\r|\n)$/, ""));
        const parsed = parseMarkdownTable(tableLines, 0, lastLineComplete || !isLast);
        if (!parsed) {
          return this.renderLiteralBlock(token.raw, width, defaultColor);
        }

        const rendered = renderMarkdownTable(parsed.table, width, {
          color: defaultColor,
          hyperlinks: this.options.hyperlinks,
          renderLatex: this.options.renderLatex,
        });
        // GFM tables accept pipe-less body rows. Kana ends a table there, so
        // re-lex any suffix that Marked included in the table token.
        const remainder = tableLines.slice(parsed.nextLine).join("\n");
        return remainder
          ? [
              ...rendered,
              ...this.renderMarkdownTokens(
                lexMarkdown(remainder),
                width,
                lastLineComplete,
                defaultColor,
              ),
            ]
          : rendered;
      }

      case "latexBlock":
        return this.renderLatexBlock(token as MarkdownBlockLatexToken, width);

      case "html":
        return this.renderLiteralBlock(token.raw, width, defaultColor);

      case "def":
        return [];

      default:
        return this.renderLiteralBlock(token.raw, width, defaultColor);
    }
  }

  private renderList(
    token: Tokens.List,
    width: number,
    baseIndent: string,
    lastLineComplete: boolean,
    defaultColor: Color,
  ): string[] {
    const lines: string[] = [];

    for (const [itemIndex, item] of token.items.entries()) {
      const sourceIndent = item.raw.match(/^\s*/)?.[0] ?? "";
      const indent = baseIndent || sourceIndent;
      const orderedMarker = item.raw.match(/^\s*(\d+[.)])(?:\s+|$)/)?.[1];
      const bullet = token.ordered
        ? `${orderedMarker ?? `${Number(token.start) + itemIndex}.`} `
        : "- ";
      const marker = item.task
        ? token.ordered
          ? `${bullet}[${item.checked ? "x" : " "}] `
          : `[${item.checked ? "x" : " "}] `
        : bullet;
      const firstPrefix = `${indent}${marker}`;
      const continuationPrefix = `${indent}${" ".repeat(visibleWidth(marker))}`;
      const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
      let renderedAnyLine = false;

      for (const [tokenIndex, itemToken] of item.tokens.entries()) {
        if (itemToken.type === "checkbox") {
          continue;
        }

        if (itemToken.type === "list") {
          lines.push(
            ...this.renderList(
              itemToken as Tokens.List,
              width,
              continuationPrefix,
              lastLineComplete,
              defaultColor,
            ),
          );
          renderedAnyLine = true;
          continue;
        }

        const itemLines =
          itemToken.type === "space"
            ? [""]
            : this.renderMarkdownToken(
                itemToken,
                itemWidth,
                lastLineComplete,
                itemIndex === token.items.length - 1 && tokenIndex === item.tokens.length - 1,
                defaultColor,
              );
        for (const line of itemLines) {
          if (!line) {
            lines.push("");
            continue;
          }
          lines.push(`${renderedAnyLine ? continuationPrefix : firstPrefix}${line}`);
          renderedAnyLine = true;
        }
      }

      if (!renderedAnyLine) {
        lines.push(firstPrefix);
      }
      if (token.loose && itemIndex + 1 < token.items.length && lines.at(-1) !== "") {
        lines.push("");
      }
    }

    return lines;
  }

  private renderLiteralBlock(raw: string, width: number, defaultColor: Color): string[] {
    const source = raw.replace(/(?:\r\n|\r|\n)$/, "");
    return splitLines(source).flatMap((line) =>
      wrapPlainLine(line, Math.max(1, width)).map((wrapped) =>
        truncateToWidth(color(wrapped, defaultColor), width, ""),
      ),
    );
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

    return renderWrappedInline(line, width, {
      defaultColor: this.options.color ?? tuiTheme.markdownText,
      hyperlinks: this.options.hyperlinks,
      renderLatex: this.options.renderLatex,
    });
  }

  private renderLatexBlock(token: MarkdownBlockLatexToken, width: number): string[] {
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
    const lines = codeLines.length ? codeLines : [""];

    if (this.options.renderMermaid !== false && language?.toLowerCase() === "mermaid") {
      const mermaid = renderMarkdownMermaid(lines.join("\n"), width, {
        color: this.options.color,
        complete: this.options.complete !== false,
      });

      if (mermaid.kind === "rendered") {
        return mermaid.lines;
      }

      const fallback = this.renderPlainCodeBlock(lines, width, language);
      return mermaid.warning
        ? [...fallback, ...this.renderMermaidWarning(mermaid.warning, width)]
        : fallback;
    }

    return this.renderPlainCodeBlock(lines, width, language);
  }

  private renderPlainCodeBlock(
    lines: string[],
    width: number,
    language: string | undefined,
  ): string[] {
    const rendered: string[] = [];
    const prefix = "    ";
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
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

  private renderMermaidWarning(warning: string, width: number): string[] {
    const safeWidth = Math.max(1, width);

    return wrapPlainLine(warning, safeWidth).map((line) =>
      truncateToWidth(color(line, tuiTheme.usageWarning), safeWidth, ""),
    );
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
