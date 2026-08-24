import stringWidth from "string-width";
import { stripCursorMarker } from "../runtime/cursor";
import { type HighlightedLineToken, RESET } from "./ansi";
import { CLOSE_TERMINAL_HYPERLINK, terminalHyperlinkState } from "./hyperlink";
import { splitLines } from "./lines";

const ANSI_PATTERN =
  // OSC strings terminate with BEL, ESC \, or C1 ST. Matching the whole
  // string keeps embedded hyperlink destinations out of visible-width math.
  /(?:(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c))|[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function visibleWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

export function stripAnsi(value: string): string {
  return stripCursorMarker(value).replace(ANSI_PATTERN, "");
}

export function stripTerminalControlSequences(value: string): string {
  return stripAnsi(value).replace(UNSAFE_CONTROL_PATTERN, "");
}

export function padRightAnsi(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function truncateToWidth(value: string, width: number, suffix = "..."): string {
  if (width <= 0) {
    return "";
  }

  if (visibleWidth(value) <= width) {
    return value;
  }

  const suffixWidth = visibleWidth(suffix);
  const available = Math.max(0, width - suffixWidth);
  let result = "";
  let currentWidth = 0;
  let index = 0;
  let usedAnsi = false;
  let hyperlinkOpen = false;

  // Iterate graphemes lazily so truncating a huge single line stays O(width)
  // instead of re-segmenting the remaining string on every step.
  const graphemeIterator = graphemeSegments(value);

  while (index < value.length) {
    const ansi = readAnsi(value, index);

    if (ansi) {
      result += ansi.sequence;
      index = ansi.end;
      usedAnsi = true;
      const hyperlinkState = terminalHyperlinkState(ansi.sequence);
      if (hyperlinkState !== undefined) {
        hyperlinkOpen = hyperlinkState === "open";
      }
      continue;
    }

    const segment = nextGraphemeAt(graphemeIterator, index);

    if (!segment) {
      break;
    }

    const segmentWidth = visibleWidth(segment);

    if (currentWidth + segmentWidth > available) {
      break;
    }

    result += segment;
    currentWidth += segmentWidth;
    index += segment.length;
  }

  if (!usedAnsi) {
    return `${result}${suffix}`;
  }

  // SGR reset does not close OSC 8, so close an active hyperlink before the
  // suffix to prevent either it or later terminal output from becoming linked.
  const hyperlinkClose = hyperlinkOpen ? CLOSE_TERMINAL_HYPERLINK : "";
  return `${result}${hyperlinkClose}${suffix}${RESET}`;
}

export function wrapPlainText(value: string, width: number): string[] {
  const columns = Math.max(width, 1);
  const lines: string[] = [];

  for (const rawLine of splitLines(value.replace(/\t/g, "   "))) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;

    for (const { segment } of graphemeSegments(rawLine)) {
      const segmentWidth = visibleWidth(segment);

      if (line && lineWidth + segmentWidth > columns) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }

      line += segment;
      lineWidth += segmentWidth;
    }

    lines.push(line);
  }

  return lines;
}

/**
 * Wraps highlighted tokens between graphemes while preserving row colors.
 */
export function wrapHighlightedLine(
  tokens: HighlightedLineToken[],
  width: number,
): HighlightedLineToken[][] {
  const columns = Math.max(width, 1);
  const lines: HighlightedLineToken[][] = [];
  let line: HighlightedLineToken[] = [];
  let lineWidth = 0;

  for (const token of tokens) {
    for (const { segment } of graphemeSegments(token.text.replace(/\t/g, "   "))) {
      const segmentWidth = visibleWidth(segment);

      if (line.length > 0 && lineWidth + segmentWidth > columns) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }

      const last = line.at(-1);
      if (last && last.color === token.color) last.text += segment;
      else line.push({ text: segment, color: token.color });
      lineWidth += segmentWidth;
    }
  }

  lines.push(line);
  return lines;
}

function graphemeSegments(value: string): IterableIterator<{ segment: string; index: number }> {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: string,
        options: { granularity: "grapheme" },
      ) => {
        segment(value: string): Iterable<{ segment: string; index: number }>;
      };
    }
  ).Segmenter;

  if (!Segmenter) {
    return codePointSegments(value);
  }

  return new Segmenter("en", { granularity: "grapheme" }).segment(value)[Symbol.iterator]();
}

/** Fallback without Intl.Segmenter: iterate code points instead of grapheme clusters. */
function* codePointSegments(value: string): IterableIterator<{ segment: string; index: number }> {
  let index = 0;

  for (const segment of value) {
    yield { segment, index };
    index += segment.length;
  }
}

/** Consumes the iterator up to the grapheme at or after `index`. */
function nextGraphemeAt(
  iterator: IterableIterator<{ segment: string; index: number }>,
  index: number,
): string | undefined {
  for (;;) {
    const next = iterator.next();

    if (next.done) {
      return undefined;
    }

    if (next.value.index >= index) {
      return next.value.segment;
    }
  }
}

function readAnsi(value: string, index: number): { sequence: string; end: number } | undefined {
  ANSI_PATTERN.lastIndex = index;
  const match = ANSI_PATTERN.exec(value);

  if (!match || match.index !== index) {
    return undefined;
  }

  return {
    sequence: match[0],
    end: index + match[0].length,
  };
}
