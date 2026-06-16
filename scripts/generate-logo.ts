import { mkdir } from "node:fs/promises";
import path from "node:path";
import { LOGO_COLORS, LOGO_PIXELS } from "../src/tui/app/welcome-logo";

const CELL = 24;
const PADDING = 24;

const OUT_DIR = "assets";
const SVG_PATH = path.join(OUT_DIR, "kana-logo.svg");

type PixelColor = keyof typeof LOGO_COLORS;

function ansiToHex(ansi: string): string {
  // LOGO_COLORS values are "48;2;R;G;B" (ANSI 24-bit background color)
  const [, , r, g, b] = ansi.split(";").map(Number);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const HEX_COLORS: Record<PixelColor, string> = {
  l: ansiToHex(LOGO_COLORS.l),
  h: ansiToHex(LOGO_COLORS.h),
  s: ansiToHex(LOGO_COLORS.s),
};

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function renderSvg(): string {
  const rows = LOGO_PIXELS.length;
  const cols = Math.max(...LOGO_PIXELS.map((row) => row.length));

  const width = cols * CELL + PADDING * 2;
  const height = rows * CELL + PADDING * 2;

  const rects: string[] = [];

  for (let y = 0; y < rows; y++) {
    const row = LOGO_PIXELS[y];

    for (let x = 0; x < row.length; x++) {
      const pixel = row[x];

      if (pixel === ".") continue;

      const color = pixel as PixelColor;

      rects.push(
        `<rect x="${PADDING + x * CELL}" y="${PADDING + y * CELL}" ` +
          `width="${CELL}" height="${CELL}" fill="${escapeXml(HEX_COLORS[color])}" />`,
      );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...rects,
    `</svg>`,
  ].join("\n");
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const svg = renderSvg();

  await Bun.write(SVG_PATH, svg);

  console.log(`Generated ${SVG_PATH}`);
}

await main();
