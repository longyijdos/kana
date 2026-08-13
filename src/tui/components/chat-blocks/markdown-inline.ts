import {
  bold,
  type Color,
  color,
  dim,
  graphemeSegments,
  italic,
  sanitizeTerminalHyperlinkDestination,
  strikethrough,
  stripTerminalControlSequences,
  terminalHyperlink,
  truncateToWidth,
  visibleWidth,
} from "../../render";
import { tuiTheme } from "../../theme";

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
    continuationPrefix?: string;
  },
): string[] {
  const prefix = options.prefix ?? "";
  const continuationPrefix = options.continuationPrefix ?? "";
  const firstWidth = Math.max(1, width - visibleWidth(prefix));
  const restWidth = Math.max(1, width - visibleWidth(continuationPrefix));
  const spans = resolveInlineLinks(parseInline(value), options.hyperlinks === true);
  const lines = wrapSpans(spans, firstWidth, restWidth);

  return lines.map((line, index) => {
    const linePrefix = index === 0 ? prefix : continuationPrefix;
    const styled = styleSpans(line, options);

    return truncateToWidth(`${linePrefix}${styled}`, width, "");
  });
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

export function parseInline(value: string): InlineSpan[] {
  return parseInlineWithStyle(normalizeInlineImages(value), {});
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
    if (value[index] === "[" && value[index - 1] !== "!") {
      // Streamed partial links remain literal until every closing delimiter is
      // present, avoiding transient or unterminated OSC state.
      const link = readInlineLink(value, index);

      if (link) {
        flushPlain();
        const destination = sanitizeTerminalHyperlinkDestination(link.destination);
        const labelSpans = parseInlineWithStyle(link.label, activeStyle);

        if (destination) {
          const inlineLink: InlineLink = {
            destination,
            fallbackDestination: link.destination,
          };
          spans.push(...labelSpans.map((span) => ({ ...span, link: inlineLink })));
        } else {
          spans.push(...labelSpans);
          const readableDestination = stripTerminalControlSequences(link.destination).replace(
            /[\u0000-\u001f\u007f-\u009f]/g,
            "",
          );
          if (readableDestination) {
            spans.push({ text: ` (${readableDestination})` });
          }
        }
        index = link.end;
        continue;
      }
    }

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
    if ((marker === "*" || marker === "_") && value[index + 1] !== marker) {
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

function normalizeInlineImages(value: string): string {
  return value.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) =>
    alt ? `[image: ${alt}] ${url}` : `[image] ${url}`,
  );
}

function readInlineLink(
  value: string,
  start: number,
): { destination: string; end: number; label: string } | undefined {
  const labelEnd = findClosingBracket(value, start);
  if (labelEnd === undefined || labelEnd === start + 1 || value[labelEnd + 1] !== "(") {
    return undefined;
  }

  let index = labelEnd + 2;
  while (isInlineWhitespace(value[index])) {
    index += 1;
  }

  const destination = readLinkDestination(value, index);
  if (!destination) {
    return undefined;
  }
  index = destination.end;

  while (isInlineWhitespace(value[index])) {
    index += 1;
  }

  if (value[index] === '"' || value[index] === "'") {
    const titleEnd = findClosingQuote(value, index, value[index]!);
    if (titleEnd === undefined) {
      return undefined;
    }
    index = titleEnd + 1;
    while (isInlineWhitespace(value[index])) {
      index += 1;
    }
  }

  if (value[index] !== ")") {
    return undefined;
  }

  return {
    destination: unescapeMarkdownDestination(destination.value),
    end: index + 1,
    label: value.slice(start + 1, labelEnd),
  };
}

function findClosingBracket(value: string, start: number): number | undefined {
  let depth = 0;

  for (let index = start + 1; index < value.length; index += 1) {
    if (isMarkdownEscape(value, index)) {
      index += 1;
      continue;
    }
    if (value[index] === "[") {
      depth += 1;
      continue;
    }
    if (value[index] === "]") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }

  return undefined;
}

function readLinkDestination(
  value: string,
  start: number,
): { end: number; value: string } | undefined {
  if (value[start] === "<") {
    for (let index = start + 1; index < value.length; index += 1) {
      if (isMarkdownEscape(value, index)) {
        index += 1;
        continue;
      }
      if (value[index] === ">") {
        return { end: index + 1, value: value.slice(start + 1, index) };
      }
      if (value[index] === "\n" || value[index] === "\r") {
        return undefined;
      }
    }
    return undefined;
  }

  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (isMarkdownEscape(value, index)) {
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        return index === start ? undefined : { end: index, value: value.slice(start, index) };
      }
      depth -= 1;
      continue;
    }
    if (isInlineWhitespace(character) && depth === 0) {
      return index === start ? undefined : { end: index, value: value.slice(start, index) };
    }
  }

  return undefined;
}

function findClosingQuote(value: string, start: number, quote: string): number | undefined {
  for (let index = start + 1; index < value.length; index += 1) {
    if (isMarkdownEscape(value, index)) {
      index += 1;
      continue;
    }
    if (value[index] === quote) {
      return index;
    }
  }

  return undefined;
}

function isInlineWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function isMarkdownEscape(value: string, index: number): boolean {
  // ESC \ terminates an OSC string; treating that backslash as Markdown
  // escaping could leave a hostile destination outside link sanitization.
  return value[index] === "\\" && value[index - 1] !== "\x1b";
}

function unescapeMarkdownDestination(value: string): string {
  return value.replace(/\\([\\()[\]<>])/g, "$1");
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
