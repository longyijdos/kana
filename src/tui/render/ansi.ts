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
  const code = typeof value === "string"
    ? COLOR_CODES[value] + 10
    : rgbCode("48", value);

  return `\x1b[${code}m${text}${ERASE_TO_END_OF_LINE}${RESET}`;
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
