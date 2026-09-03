import { bundledThemes } from "shiki";

import type { RgbTuple, TuiSyntaxTheme, TuiTheme, TuiThemeColors } from "./types";
import { TUI_THEME_COLOR_KEYS } from "./types";

// Theme files (built-in specs and user JSON) describe colors as "#rrggbb"
// strings. compileTuiTheme is the single conversion path into the RGB tuples
// the renderer consumes, so built-in and user themes share one validator.

export type TuiThemeSpec = {
  name: string;
  syntaxTheme: TuiSyntaxTheme;
  colors: Record<string, string>;
};

export function compileTuiTheme(spec: TuiThemeSpec): TuiTheme {
  if (spec.name.trim() === "") {
    throw new Error("Theme name must be a non-empty string.");
  }

  const colors = {} as TuiThemeColors;

  for (const key of TUI_THEME_COLOR_KEYS) {
    const hex = spec.colors[key];
    if (typeof hex !== "string") {
      throw new Error(`Theme "${spec.name}" is missing color "${key}".`);
    }
    colors[key] = parseHexColor(hex, `Theme "${spec.name}" color "${key}"`);
  }

  return {
    name: spec.name,
    syntaxTheme: spec.syntaxTheme,
    colors,
  };
}

export function parseUserThemeJson(name: string, source: string): TuiTheme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Theme file "${name}.json" is not valid JSON.`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Theme file "${name}.json" must contain a JSON object.`);
  }

  const spec = parsed as Record<string, unknown>;
  const declaredName = spec.name;
  if (declaredName !== name) {
    throw new Error(
      `Theme file "${name}.json" declares name "${String(declaredName)}"; the file name must match its theme name.`,
    );
  }

  const colors = spec.colors;
  if (typeof colors !== "object" || colors === null || Array.isArray(colors)) {
    throw new Error(`Theme "${name}" must declare a "colors" table.`);
  }

  return compileTuiTheme({
    name,
    syntaxTheme: parseSyntaxTheme(spec.syntaxTheme, name),
    colors: colors as Record<string, string>,
  });
}

function parseSyntaxTheme(value: unknown, name: string): TuiSyntaxTheme {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Theme "${name}" must declare a non-empty "syntaxTheme".`);
  }
  if (!isSupportedSyntaxTheme(value)) {
    throw new Error(
      `Theme "${name}" uses unsupported syntax theme "${value}". Supported themes: ${BUNDLED_SYNTAX_THEMES.join(", ")}.`,
    );
  }
  return value;
}

function isSupportedSyntaxTheme(value: string): value is TuiSyntaxTheme {
  return BUNDLED_SYNTAX_THEMES.includes(value);
}

const BUNDLED_SYNTAX_THEMES = Object.keys(bundledThemes);

function parseHexColor(value: string, path: string): RgbTuple {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`${path} must be a "#rrggbb" hex color.`);
  }

  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);

  return [red, green, blue] as const;
}
