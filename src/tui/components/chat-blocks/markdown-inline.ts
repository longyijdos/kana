import {
  bold,
  type Color,
  color,
  dim,
  graphemeSegments,
  italic,
  strikethrough,
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
  text: string;
  style?: InlineStyle;
};

export function renderWrappedInline(
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

export function wrapSpans(
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
