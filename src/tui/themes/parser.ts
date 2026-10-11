import { type BundledTheme, bundledThemes } from "shiki";
import { Type } from "typebox";
import { parseWithSchema, strictObject } from "@/utils";
import {
  TUI_THEME_COLOR_KEYS,
  type TuiPalette,
  type TuiTheme,
  type TuiThemeColorKey,
} from "./types";

const HEX_COLOR = Type.String({
  pattern: "^#[0-9a-fA-F]{6}$",
  errorMessage: "must use #rrggbb format",
});

const THEME_SCHEMA = strictObject({
  syntaxTheme: Type.String({
    enum: Object.keys(bundledThemes),
    errorMessage: "must name a bundled Shiki theme",
  }),
  colors: strictObject(
    Object.fromEntries(TUI_THEME_COLOR_KEYS.map((key) => [key, HEX_COLOR])) as Record<
      TuiThemeColorKey,
      typeof HEX_COLOR
    >,
  ),
});

export function parseUserTuiTheme(name: string, value: unknown): TuiTheme {
  const theme = parseWithSchema(THEME_SCHEMA, value, `TUI theme ${name}`);
  const colors = {} as Record<TuiThemeColorKey, TuiPalette[TuiThemeColorKey]>;
  for (const key of TUI_THEME_COLOR_KEYS) {
    const hex = theme.colors[key];
    colors[key] = [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
  }
  return { name, syntaxTheme: theme.syntaxTheme as BundledTheme, colors };
}
