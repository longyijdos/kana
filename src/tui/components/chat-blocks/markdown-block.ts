import {
  bold,
  color,
  dim,
  graphemeSegments,
  italic,
  splitLines,
  strikethrough,
  truncateToWidth,
  visibleWidth,
  type Color,
} from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";

type InlineStyle = {
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  strike?: boolean;
};

type InlineSpan = {
  text: string;
  style?: InlineStyle;
};

type MarkdownBlockOptions = {
  color?: Color;
};

export class MarkdownBlock implements Component {
  constructor(
    private text: string,
    private readonly options: MarkdownBlockOptions = {},
  ) {}

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    let codeBlock: string[] | undefined;

    for (const rawLine of splitLines(this.text)) {
      const fence = rawLine.match(/^\s*```([\w-]+)?\s*$/);

      if (fence) {
        if (codeBlock) {
          lines.push(...this.renderCodeBlock(codeBlock, width));
          codeBlock = undefined;
        } else {
          codeBlock = [];
        }
        continue;
      }

      if (codeBlock) {
        codeBlock.push(rawLine);
        continue;
      }

      lines.push(...this.renderMarkdownLine(rawLine, width));
    }

    if (codeBlock) {
      lines.push(...this.renderCodeBlock(codeBlock, width));
    }

    return lines.length ? lines : [""];
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
      return [
        color(
          "-".repeat(Math.min(Math.max(1, width), 40)),
          tuiTheme.markdownRule,
        ),
      ];
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

  private renderCodeBlock(codeLines: string[], width: number): string[] {
    const rendered: string[] = [];
    const prefix = "    ";
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    const lines = codeLines.length ? codeLines : [""];

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
}

function renderWrappedInline(
  value: string,
  width: number,
  options: {
    defaultColor?: Color;
    dim?: boolean;
    forceBold?: boolean;
    prefix?: string;
    continuationPrefix?: string;
  },
): string[] {
  const prefix = options.prefix ?? "";
  const continuationPrefix = options.continuationPrefix ?? "";
  const firstWidth = Math.max(1, width - visibleWidth(prefix));
  const restWidth = Math.max(1, width - visibleWidth(continuationPrefix));
  const lines = wrapSpans(parseInline(value), firstWidth, restWidth);

  return lines.map((line, index) => {
    const linePrefix = index === 0 ? prefix : continuationPrefix;
    const styled = styleSpans(line, options);

    return truncateToWidth(`${linePrefix}${styled}`, width, "");
  });
}

function parseInline(value: string): InlineSpan[] {
  return parseInlineWithStyle(normalizeInlineMarkdown(value), {});
}

function parseInlineWithStyle(value: string, activeStyle: InlineStyle): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = (): void => {
    if (plain) {
      spans.push({
        text: plain,
        style: styleOrUndefined(activeStyle),
      });
      plain = "";
    }
  };

  while (index < value.length) {
    if (value[index] === "`") {
      const end = value.indexOf("`", index + 1);

      if (end > index + 1) {
        flushPlain();
        spans.push({
          text: value.slice(index + 1, end),
          style: { code: true },
        });
        index = end + 1;
        continue;
      }
    }

    if (value.startsWith("***", index)) {
      const end = value.indexOf("***", index + 3);

      if (end > index + 3) {
        flushPlain();
        spans.push(
          ...parseInlineWithStyle(value.slice(index + 3, end), {
            ...activeStyle,
            bold: true,
            italic: true,
          }),
        );
        index = end + 3;
        continue;
      }
    }

    if (value.startsWith("~~", index)) {
      const end = value.indexOf("~~", index + 2);

      if (end > index + 2) {
        flushPlain();
        spans.push(
          ...parseInlineWithStyle(value.slice(index + 2, end), {
            ...activeStyle,
            strike: true,
          }),
        );
        index = end + 2;
        continue;
      }
    }

    if (value.startsWith("**", index)) {
      const end = value.indexOf("**", index + 2);

      if (end > index + 2) {
        flushPlain();
        spans.push(
          ...parseInlineWithStyle(value.slice(index + 2, end), {
            ...activeStyle,
            bold: true,
          }),
        );
        index = end + 2;
        continue;
      }
    }

    const marker = value[index];
    if (
      (marker === "*" || marker === "_") &&
      value[index + 1] !== marker
    ) {
      const end = value.indexOf(marker, index + 1);

      if (end > index + 1 && value[end + 1] !== marker) {
        flushPlain();
        spans.push(
          ...parseInlineWithStyle(value.slice(index + 1, end), {
            ...activeStyle,
            italic: true,
          }),
        );
        index = end + 1;
        continue;
      }
    }

    plain += value[index];
    index += 1;
  }

  flushPlain();

  return spans;
}

function wrapSpans(
  spans: InlineSpan[],
  firstWidth: number,
  restWidth: number,
): InlineSpan[][] {
  const lines: InlineSpan[][] = [];
  let current: InlineSpan[] = [];
  let currentWidth = 0;

  const pushSegment = (segment: string, style: InlineStyle | undefined): void => {
    const limit = lines.length === 0 ? firstWidth : restWidth;
    const segmentWidth = visibleWidth(segment);

    if (current.length && currentWidth + segmentWidth > limit) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }

    const last = current.at(-1);
    if (last && sameStyle(last.style, style)) {
      last.text += segment;
    } else {
      current.push({ text: segment, style });
    }
    currentWidth += segmentWidth;
  };

  for (const span of spans) {
    for (const { segment } of graphemeSegments(span.text)) {
      pushSegment(segment, span.style);
    }
  }

  if (current.length || lines.length === 0) {
    lines.push(current);
  }

  return lines;
}

function styleSpans(
  spans: InlineSpan[],
  options: {
    defaultColor?: Color;
    dim?: boolean;
    forceBold?: boolean;
  },
): string {
  let rendered = spans
    .map((span) => {
      let text = span.text;

      if (span.style?.code) {
        text = color(text, tuiTheme.markdownInlineCode);
      } else if (options.defaultColor) {
        text = color(text, options.defaultColor);
      }

      if (span.style?.bold || options.forceBold) {
        text = bold(text);
      }

      if (span.style?.italic) {
        text = italic(text);
      }

      if (span.style?.strike) {
        text = strikethrough(text);
      }

      return text;
    })
    .join("");

  if (options.dim) {
    rendered = dim(rendered);
  }

  return rendered;
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

function normalizeInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) =>
      alt ? `[image: ${alt}] ${url}` : `[image] ${url}`,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)");
}

function sameStyle(left: InlineStyle | undefined, right: InlineStyle | undefined): boolean {
  return (
    Boolean(left?.bold) === Boolean(right?.bold) &&
    Boolean(left?.code) === Boolean(right?.code) &&
    Boolean(left?.italic) === Boolean(right?.italic) &&
    Boolean(left?.strike) === Boolean(right?.strike)
  );
}

function styleOrUndefined(style: InlineStyle): InlineStyle | undefined {
  return style.bold || style.code || style.italic || style.strike
    ? { ...style }
    : undefined;
}

function wrapPlainLine(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;

  if (!value) {
    return [""];
  }

  for (const { segment } of graphemeSegments(value)) {
    const segmentWidth = visibleWidth(segment);

    if (line && lineWidth + segmentWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }

    line += segment;
    lineWidth += segmentWidth;
  }

  lines.push(line);

  return lines;
}
