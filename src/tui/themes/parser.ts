import { type BundledTheme, bundledThemes } from "shiki";
import {
  TUI_THEME_COLOR_KEYS,
  type TuiPalette,
  type TuiTheme,
  type TuiThemeColorKey,
} from "./types";

const ROOT_KEYS = new Set(["syntaxTheme", "colors"]);
const COLOR_KEYS = new Set<string>(TUI_THEME_COLOR_KEYS);

export function parseUserTuiTheme(name: string, value: unknown): TuiTheme {
  const root = asRecord(value, `TUI theme ${name}`);
  assertKnownKeys(root, ROOT_KEYS, `TUI theme ${name}`);
  const rawColors = asRecord(root.colors, `TUI theme ${name}.colors`);
  assertKnownKeys(rawColors, COLOR_KEYS, `TUI theme ${name}.colors`);

  const colors = {} as Record<TuiThemeColorKey, TuiPalette[TuiThemeColorKey]>;
  for (const key of TUI_THEME_COLOR_KEYS) {
    colors[key] = parseHexColor(rawColors[key], `TUI theme ${name}.colors.${key}`);
  }

  return {
    name,
    syntaxTheme: parseBundledTheme(root.syntaxTheme, `TUI theme ${name}.syntaxTheme`),
    colors,
  };
}

function parseBundledTheme(value: unknown, label: string): BundledTheme {
  if (typeof value !== "string" || !Object.hasOwn(bundledThemes, value)) {
    throw new Error(`${label} must name a bundled Shiki theme.`);
  }
  return value as BundledTheme;
}

function parseHexColor(value: unknown, label: string): readonly [number, number, number] {
  if (value === undefined) {
    throw new Error(`${label} is required.`);
  }
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${label} must use #rrggbb format.`);
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${label} contains unknown field ${unknown}.`);
  }
}
