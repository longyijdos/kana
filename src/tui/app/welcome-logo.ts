const RESET = "\x1b[0m";
const PIXEL = "  ";

const COLORS = {
  l: "48;2;88;184;73",
  h: "48;2;158;220;91",
  s: "48;2;82;167;66",
} as const;

const CILANTRO_PIXELS = [
  "......h....",
  ".....hlh...",
  "...h..s....",
  "..hlsss.h..",
  "...h..sslh.",
  ".....s..h..",
  "....s......",
] as const;

export const WELCOME_LOGO_LINES = CILANTRO_PIXELS.map(renderPixelRow);

function renderPixelRow(row: string): string {
  let line = "";
  let currentColor: keyof typeof COLORS | undefined;

  for (const pixel of row) {
    if (pixel === ".") {
      if (currentColor) {
        line += RESET;
        currentColor = undefined;
      }

      line += PIXEL;
      continue;
    }

    const color = pixel as keyof typeof COLORS;

    if (currentColor !== color) {
      line += `\x1b[${COLORS[color]}m`;
      currentColor = color;
    }

    line += PIXEL;
  }

  return currentColor ? `${line}${RESET}` : line;
}
