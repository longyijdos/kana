import type { TerminalColorMode } from "../runtime/terminal-capabilities";

type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

type RgbColor = readonly [red: number, green: number, blue: number];
export type Color = AnsiColor | RgbColor;
export type HighlightedLineToken = { text: string; color?: Color | string };

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
const XTERM_CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const XTERM_GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

export const RESET = "\x1b[0m";
const ERASE_TO_END_OF_LINE = "\x1b[K";
let terminalColorMode: TerminalColorMode = "truecolor";

export function setTerminalColorMode(mode: TerminalColorMode): void {
  terminalColorMode = mode;
}

export function getTerminalColorMode(): TerminalColorMode {
  return terminalColorMode;
}

export function color(text: string, value: Color): string {
  const code = foregroundCode(value);
  return code === undefined ? text : `\x1b[${code}m${text}${RESET}`;
}

export function backgroundColor(text: string, value: Color): string {
  const code = backgroundCode(value);
  return code === undefined ? text : `\x1b[${code}m${text}${RESET}`;
}

export function renderHighlightedLine(
  tokens: HighlightedLineToken[],
  options: { background?: Color; clearToEnd?: boolean; prefix?: string } = {},
): string {
  const background = options.background ? backgroundCode(options.background) : undefined;
  let rendered = background === undefined ? "" : `\x1b[${background}m`;
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

  return background !== undefined || foregroundActive ? `${rendered}${RESET}` : rendered;
}

function backgroundCode(value: Color): string | undefined {
  if (terminalColorMode === "uncolored") {
    return undefined;
  }
  return typeof value === "string" ? String(COLOR_CODES[value] + 10) : rgbCode("48", value);
}

function foregroundCode(value: Color | string | undefined): string | undefined {
  if (!value || terminalColorMode === "uncolored") {
    return undefined;
  }

  if (typeof value !== "string") {
    return rgbCode("38", value);
  }

  const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);

  if (hex) {
    return rgbCode("38", [
      Number.parseInt(hex[1]!, 16),
      Number.parseInt(hex[2]!, 16),
      Number.parseInt(hex[3]!, 16),
    ]);
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
  const rgb: RgbColor = [clampRgb(value[0]), clampRgb(value[1]), clampRgb(value[2])];
  if (terminalColorMode === "ansi256") {
    return `${prefix};5;${rgbToXterm256(rgb)}`;
  }
  return `${prefix};2;${rgb.join(";")}`;
}

export function rgbToXterm256(value: RgbColor): number {
  const [red, green, blue] = value.map(clampRgb);
  const distance = (targetRed: number, targetGreen: number, targetBlue: number) =>
    (red - targetRed) ** 2 * 0.299 +
    (green - targetGreen) ** 2 * 0.587 +
    (blue - targetBlue) ** 2 * 0.114;
  const redIndex = nearestColorIndex(red, XTERM_CUBE_VALUES);
  const greenIndex = nearestColorIndex(green, XTERM_CUBE_VALUES);
  const blueIndex = nearestColorIndex(blue, XTERM_CUBE_VALUES);
  const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;
  const cubeDistance = distance(
    XTERM_CUBE_VALUES[redIndex]!,
    XTERM_CUBE_VALUES[greenIndex]!,
    XTERM_CUBE_VALUES[blueIndex]!,
  );
  const luminance = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
  const grayIndex = nearestColorIndex(luminance, XTERM_GRAY_VALUES);
  const grayValue = XTERM_GRAY_VALUES[grayIndex]!;
  const grayDistance = distance(grayValue, grayValue, grayValue);

  return Math.max(red, green, blue) - Math.min(red, green, blue) < 10 && grayDistance < cubeDistance
    ? 232 + grayIndex
    : cubeIndex;
}

function nearestColorIndex(value: number, candidates: readonly number[]): number {
  let result = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (Math.abs(value - candidates[index]!) < Math.abs(value - candidates[result]!)) {
      result = index;
    }
  }
  return result;
}
