export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

export type RgbColor = readonly [red: number, green: number, blue: number];
export type Color = AnsiColor | RgbColor;
export type HighlightedLineToken = { text: string; color?: string };

const COLOR_CODES: Record<AnsiColor, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

export const RESET = "\x1b[0m";
const ERASE_TO_END_OF_LINE = "\x1b[K";

export function color(text: string, value: Color): string {
  if (typeof value !== "string") {
    return `\x1b[${rgbCode("38", value)}m${text}${RESET}`;
  }

  return `\x1b[${COLOR_CODES[value]}m${text}${RESET}`;
}

export function background(text: string, value: Color): string {
  return renderHighlightedLine([{ text }], {
    background: value,
    clearToEnd: true,
  });
}

export function renderHighlightedLine(
  tokens: HighlightedLineToken[],
  options: { background?: Color; clearToEnd?: boolean; prefix?: string } = {},
): string {
  let rendered = options.background ? `\x1b[${backgroundCode(options.background)}m` : "";
  let foregroundActive = false;

  rendered += options.prefix ?? "";

  for (const token of tokens) {
    const code = foregroundCode(token.color);

    if (code) {
      rendered += `\x1b[${code}m`;
      foregroundActive = true;
    } else if (foregroundActive) {
      rendered += "\x1b[39m";
      foregroundActive = false;
    }

    rendered += token.text;
  }

  if (options.clearToEnd) {
    rendered += ERASE_TO_END_OF_LINE;
  }

  return options.background || foregroundActive ? `${rendered}${RESET}` : rendered;
}

function backgroundCode(value: Color): string {
  return typeof value === "string" ? String(COLOR_CODES[value] + 10) : rgbCode("48", value);
}

function foregroundCode(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);

  if (hex) {
    return `38;2;${parseInt(hex[1]!, 16)};${parseInt(hex[2]!, 16)};${parseInt(hex[3]!, 16)}`;
  }

  return COLOR_CODES[value as AnsiColor]?.toString();
}

export function bold(text: string): string {
  return `\x1b[1m${text}${RESET}`;
}

export function italic(text: string): string {
  return `\x1b[3m${text}${RESET}`;
}

export function strikethrough(text: string): string {
  return `\x1b[9m${text}${RESET}`;
}

export function dim(text: string): string {
  return `\x1b[2m${text}${RESET}`;
}

function clampRgb(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbCode(prefix: "38" | "48", value: RgbColor): string {
  const [red, green, blue] = value;
  return `${prefix};2;${clampRgb(red)};${clampRgb(green)};${clampRgb(blue)}`;
}
