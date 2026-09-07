import { backgroundColor, getTerminalColorMode } from "../render";

const PIXEL = "  ";
const VISIBLE_PIXEL = "██";

export const LOGO_COLORS = {
  l: [88, 184, 73],
  h: [158, 220, 91],
  s: [82, 167, 66],
} as const;

export const LOGO_PIXELS = [
  "......h....",
  ".....hlh...",
  "...h..s....",
  "..hlsss.h..",
  "...h..sslh.",
  ".....s..h..",
  "....s......",
] as const;

export function renderWelcomeLogoLines(): string[] {
  const colored = getTerminalColorMode() !== "uncolored";
  return LOGO_PIXELS.map((row) =>
    [...row]
      .map((pixel) => {
        if (pixel === ".") {
          return PIXEL;
        }
        return colored
          ? backgroundColor(PIXEL, LOGO_COLORS[pixel as keyof typeof LOGO_COLORS])
          : VISIBLE_PIXEL;
      })
      .join(""),
  );
}
