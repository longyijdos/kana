import stringWidth from "string-width";
import { stripCursorMarker } from "../runtime/cursor";

const ANSI_PATTERN =
  // Covers the SGR sequences emitted by this TUI and common OSC/CSI output.
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function visibleWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

export function stripAnsi(value: string): string {
  return stripCursorMarker(value).replace(ANSI_PATTERN, "");
}

export function padRightAnsi(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function truncateToWidth(
  value: string,
  width: number,
  suffix = "...",
): string {
  if (width <= 0) {
    return "";
  }

  if (visibleWidth(value) <= width) {
    return value;
  }

  const plain = stripAnsi(value);
  const suffixWidth = visibleWidth(suffix);
  const available = Math.max(0, width - suffixWidth);
  let result = "";
  let currentWidth = 0;

  for (const segment of graphemes(plain)) {
    const segmentWidth = visibleWidth(segment);

    if (currentWidth + segmentWidth > available) {
      break;
    }

    result += segment;
    currentWidth += segmentWidth;
  }

  return `${result}${suffix}`;
}

export function wrapPlainText(value: string, width: number): string[] {
  const columns = Math.max(width, 1);
  const lines: string[] = [];

  for (const rawLine of value.replace(/\t/g, "   ").split("\n")) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;

    for (const segment of graphemes(rawLine)) {
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

function graphemes(value: string): string[] {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: string,
        options: { granularity: "grapheme" },
      ) => {
        segment(value: string): Iterable<{ segment: string }>;
      };
    }
  ).Segmenter;

  if (!Segmenter) {
    return Array.from(value);
  }

  return Array.from(
    new Segmenter("en", { granularity: "grapheme" }).segment(value),
    (segment) => segment.segment,
  );
}
