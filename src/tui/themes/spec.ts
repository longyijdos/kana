import type { RgbTuple, TuiSyntaxTheme, TuiTheme, TuiThemeHexColors } from "./types";
import { isValidThemeName, TUI_THEME_COLOR_KEYS } from "./types";

// Compiling a theme spec (built-in or parsed user JSON) into the RGB-tuple
// shape the renderer consumes. This module has no runtime dependencies beyond
// the shared types, so importing the active palette never drags in shiki or
// the filesystem loader.

export type TuiThemeSpec = {
  name: string;
  syntaxTheme: TuiSyntaxTheme;
  colors: TuiThemeHexColors;
};

export function compileTuiTheme(spec: TuiThemeSpec): TuiTheme {
  if (!isValidThemeName(spec.name)) {
    throw new Error(
      `Invalid theme name "${spec.name}"; theme names may only contain letters, digits, ".", "_", and "-".`,
    );
  }

  const colors = {} as TuiTheme["colors"];

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

function parseHexColor(value: string, path: string): RgbTuple {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`${path} must be a "#rrggbb" hex color.`);
  }

  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);

  return [red, green, blue] as const;
}
