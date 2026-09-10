import type { Token, Tokens } from "marked";
import {
  bold,
  type Color,
  color,
  dim,
  graphemeSegments,
  italic,
  renderLatex,
  sanitizeTerminalHyperlinkDestination,
  strikethrough,
  stripTerminalControlSequences,
  terminalHyperlink,
  truncateToWidth,
  visibleWidth,
} from "../../render";
import { tuiTheme } from "../../theme";
import { lexMarkdownInline, type MarkdownLatexToken } from "./markdown-parser";

type InlineStyle = {
  bold?: boolean;
  code?: boolean;
  color?: string;
  italic?: boolean;
  strike?: boolean;
};

export type InlineSpan = {
  link?: InlineLink;
  text: string;
  style?: InlineStyle;
};

type InlineLink = {
  // One shared object marks all styled spans from the same Markdown link so
  // fallback rendering appends its destination exactly once.
  destination: string;
  fallbackDestination: string;
};

export function renderWrappedInline(
  value: string,
  width: number,
  options: {
    defaultColor?: Color;
    dim?: boolean;
    forceBold?: boolean;
    hyperlinks?: boolean;
    prefix?: string;
    renderLatex?: boolean;
    continuationPrefix?: string;
  },
): string[] {
  return renderWrappedInlineTokens(lexMarkdownInline(value), width, options);
}

export function renderWrappedInlineTokens(
  tokens: readonly Token[],
  width: number,
  options: {
    defaultColor?: Color;
    dim?: boolean;
    forceBold?: boolean;
    hyperlinks?: boolean;
    prefix?: string;
    renderLatex?: boolean;
    continuationPrefix?: string;
  },
): string[] {
  const prefix = options.prefix ?? "";
  const continuationPrefix = options.continuationPrefix ?? "";
  const firstWidth = Math.max(1, width - visibleWidth(prefix));
  const restWidth = Math.max(1, width - visibleWidth(continuationPrefix));
  const spans = resolveInlineLinks(
    inlineTokensToSpans(tokens, {}, { renderLatex: options.renderLatex }),
    options.hyperlinks === true,
  );
  const lines: InlineSpan[][] = [];

  for (const logicalLine of splitSpanLines(spans)) {
    lines.push(...wrapSpans(logicalLine, lines.length === 0 ? firstWidth : restWidth, restWidth));
  }

  return lines.map((line, index) => {
    const linePrefix = index === 0 ? prefix : continuationPrefix;
    const styled = styleSpans(line, options);

    return truncateToWidth(`${linePrefix}${styled}`, width, "");
  });
}

function splitSpanLines(spans: InlineSpan[]): InlineSpan[][] {
  const lines: InlineSpan[][] = [[]];

  for (const span of spans) {
    const segments = span.text.split("\n");
    for (const [index, segment] of segments.entries()) {
      if (segment) {
        lines.at(-1)?.push({ ...span, text: segment });
      }
      if (index + 1 < segments.length) {
        lines.push([]);
      }
    }
  }

  return lines;
}

export function wrapSpans(
  spans: InlineSpan[],
  firstWidth: number,
  restWidth: number,
): InlineSpan[][] {
  const lines: InlineSpan[][] = [];
  let current: InlineSpan[] = [];
  let currentWidth = 0;

  const pushSegment = (
    segment: string,
    style: InlineStyle | undefined,
    link: InlineLink | undefined,
  ): void => {
    const limit = lines.length === 0 ? firstWidth : restWidth;
    const segmentWidth = visibleWidth(segment);

    if (current.length && currentWidth + segmentWidth > limit) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }

    const last = current.at(-1);
    if (last && last.link === link && sameStyle(last.style, style)) {
      last.text += segment;
    } else {
      current.push({ link, text: segment, style });
    }
    currentWidth += segmentWidth;
  };

  for (const span of spans) {
    for (const { segment } of graphemeSegments(span.text)) {
      pushSegment(segment, span.style, span.link);
    }
  }

  if (current.length || lines.length === 0) {
    lines.push(current);
  }

  return lines;
}

export function styleSpans(
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
      } else if (span.style?.color) {
        text = colorHex(text, span.style.color);
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

      if (span.link) {
        text = terminalHyperlink(text, span.link.destination);
      }

      return text;
    })
    .join("");

  if (options.dim) {
    rendered = dim(rendered);
  }

  return rendered;
}

export function wrapPlainLine(value: string, width: number): string[] {
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

export function parseInline(value: string, options: { renderLatex?: boolean } = {}): InlineSpan[] {
  return inlineTokensToSpans(lexMarkdownInline(value), {}, options);
}

export function resolveInlineLinks(spans: InlineSpan[], hyperlinks: boolean): InlineSpan[] {
  if (hyperlinks) {
    return spans;
  }

  // Expand fallback text before measuring and wrapping so unsupported
  // terminals use the same visible-width path as every other inline span.
  const resolved: InlineSpan[] = [];
  let index = 0;

  while (index < spans.length) {
    const span = spans[index]!;
    if (!span.link) {
      resolved.push(span);
      index += 1;
      continue;
    }

    const link = span.link;
    while (index < spans.length && spans[index]?.link === link) {
      const linkedSpan = spans[index]!;
      resolved.push({ text: linkedSpan.text, style: linkedSpan.style });
      index += 1;
    }
    resolved.push({ text: ` (${link.fallbackDestination})` });
  }

  return resolved;
}

function inlineTokensToSpans(
  tokens: readonly Token[],
  activeStyle: InlineStyle,
  options: { renderLatex?: boolean },
): InlineSpan[] {
  const spans: InlineSpan[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const unsafeLinkEnd = appendUnsafeLinkFallback(spans, tokens, index, activeStyle, options);
    if (unsafeLinkEnd !== undefined) {
      index = unsafeLinkEnd;
      continue;
    }

    switch (token.type) {
      case "text":
      case "escape": {
        const textToken = token as Tokens.Text | Tokens.Escape;
        spans.push({ text: textToken.text, style: styleOrUndefined(activeStyle) });
        break;
      }

      case "html":
        spans.push({ text: token.raw, style: styleOrUndefined(activeStyle) });
        break;

      case "strong":
        spans.push(
          ...inlineTokensToSpans(
            (token as Tokens.Strong).tokens,
            { ...activeStyle, bold: true },
            options,
          ),
        );
        break;

      case "em":
        spans.push(
          ...inlineTokensToSpans(
            (token as Tokens.Em).tokens,
            { ...activeStyle, italic: true },
            options,
          ),
        );
        break;

      case "del":
        spans.push(
          ...inlineTokensToSpans(
            (token as Tokens.Del).tokens,
            { ...activeStyle, strike: true },
            options,
          ),
        );
        break;

      case "codespan":
        spans.push({
          text: (token as Tokens.Codespan).text,
          style: styleOrUndefined({ ...activeStyle, code: true }),
        });
        break;

      case "link":
        appendLinkSpans(spans, token as Tokens.Link, activeStyle, options);
        break;

      case "image":
        appendImageSpan(spans, token as Tokens.Image, activeStyle);
        break;

      case "latex": {
        const latex = token as MarkdownLatexToken;
        const rendered =
          latex.pending || options.renderLatex === false ? undefined : renderLatex(latex.text);
        spans.push({
          // Multi-line environments cannot participate in Kana's inline span
          // wrapping without corrupting line boundaries, so keep those literal.
          text: rendered !== undefined && !/[\r\n]/.test(rendered) ? rendered : latex.raw,
          style: styleOrUndefined(activeStyle),
        });
        break;
      }

      case "br":
        spans.push({ text: "\n", style: styleOrUndefined(activeStyle) });
        break;

      default:
        spans.push({ text: token.raw, style: styleOrUndefined(activeStyle) });
    }
  }

  return spans;
}

function appendUnsafeLinkFallback(
  spans: InlineSpan[],
  tokens: readonly Token[],
  index: number,
  activeStyle: InlineStyle,
  options: { renderLatex?: boolean },
): number | undefined {
  // A terminal control inside a destination makes Marked split the link into
  // text/autolink/text tokens. Recover only that unsafe shape so it degrades
  // to Kana's inert label-and-destination fallback.
  const opening = tokens[index];
  const destination = tokens[index + 1];
  const closing = tokens[index + 2];
  if (opening?.type !== "text" || destination?.type !== "link" || closing?.type !== "text") {
    return undefined;
  }

  const link = destination as Tokens.Link;
  const match = (opening as Tokens.Text).text.match(/^(.*)\[([^\]\n]+)\]\($/);
  const readableDestination = readableTerminalText(link.raw);
  if (
    !link.autolink ||
    !match ||
    !closing.raw.startsWith(")") ||
    readableDestination === link.raw
  ) {
    return undefined;
  }

  if (match[1]) {
    spans.push({ text: match[1], style: styleOrUndefined(activeStyle) });
  }
  spans.push(...inlineTokensToSpans(lexMarkdownInline(match[2] ?? ""), activeStyle, options));
  if (readableDestination) {
    spans.push({ text: ` (${readableDestination})` });
  }
  if (closing.raw.length > 1) {
    spans.push({ text: closing.raw.slice(1), style: styleOrUndefined(activeStyle) });
  }

  return index + 2;
}

function appendLinkSpans(
  spans: InlineSpan[],
  token: Tokens.Link,
  activeStyle: InlineStyle,
  options: { renderLatex?: boolean },
): void {
  if (token.autolink) {
    spans.push({
      text: readableTerminalText(token.raw),
      style: styleOrUndefined(activeStyle),
    });
    return;
  }

  const labelSpans = inlineTokensToSpans(token.tokens, activeStyle, options);
  const destination = sanitizeTerminalHyperlinkDestination(token.href);
  if (destination) {
    const inlineLink: InlineLink = {
      destination,
      fallbackDestination: token.href,
    };
    spans.push(...labelSpans.map((span) => ({ ...span, link: inlineLink })));
    return;
  }

  spans.push(...labelSpans);
  const readableDestination = readableTerminalText(token.href);
  if (readableDestination) {
    spans.push({ text: ` (${readableDestination})` });
  }
}

function appendImageSpan(spans: InlineSpan[], token: Tokens.Image, activeStyle: InlineStyle): void {
  const label = readableTerminalText(token.text);
  const destination = readableTerminalText(token.href);
  const description = label ? `[image: ${label}]` : "[image]";
  spans.push({
    text: destination ? `${description} ${destination}` : description,
    style: styleOrUndefined(activeStyle),
  });
}

function readableTerminalText(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function sameStyle(left: InlineStyle | undefined, right: InlineStyle | undefined): boolean {
  return (
    Boolean(left?.bold) === Boolean(right?.bold) &&
    Boolean(left?.code) === Boolean(right?.code) &&
    left?.color === right?.color &&
    Boolean(left?.italic) === Boolean(right?.italic) &&
    Boolean(left?.strike) === Boolean(right?.strike)
  );
}

function styleOrUndefined(style: InlineStyle): InlineStyle | undefined {
  return style.bold || style.code || style.color || style.italic || style.strike
    ? { ...style }
    : undefined;
}

function colorHex(text: string, value: string): string {
  const match = value.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);

  if (!match) {
    return text;
  }

  const hex = match[1] ?? "";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);

  return color(text, [red, green, blue]);
}
