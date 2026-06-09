export type Color =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

export type BackgroundColor =
  | "diffDelete"
  | "diffInsert";

const COLOR_CODES: Record<Color, number> = {
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

const BACKGROUND_CODES: Record<BackgroundColor, string> = {
  diffDelete: "48;2;70;24;24",
  diffInsert: "48;2;18;70;38",
};

export const RESET = "\x1b[0m";
const ERASE_TO_END_OF_LINE = "\x1b[K";

export function color(text: string, value: Color): string {
  return `\x1b[${COLOR_CODES[value]}m${text}${RESET}`;
}

export function background(text: string, value: BackgroundColor): string {
  return `\x1b[${BACKGROUND_CODES[value]}m${text}${ERASE_TO_END_OF_LINE}${RESET}`;
}

export function bold(text: string): string {
  return `\x1b[1m${text}${RESET}`;
}

export function dim(text: string): string {
  return `\x1b[2m${text}${RESET}`;
}
