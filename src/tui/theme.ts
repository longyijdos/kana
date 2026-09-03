import { getBuiltInTheme } from "./themes/loader";
import { TUI_THEME_COLOR_KEYS, type TuiTheme, type TuiThemeColors } from "./themes/types";

function createDefaultPalette(): TuiThemeColors {
  const palette = {} as TuiThemeColors;
  const builtIn = getBuiltInTheme();

  for (const key of TUI_THEME_COLOR_KEYS) {
    palette[key] = builtIn.colors[key];
  }

  return palette;
}

// Active semantic palette. Components read tuiTheme.* at render time. The
// built-in Kana palette is the module default so rendering works even before
// applyTuiTheme() runs (tests, headless, early startup frames), and startup
// applies the configured theme before the first paint.
export const tuiTheme: TuiThemeColors = createDefaultPalette();

export function applyTuiTheme(theme: TuiTheme): void {
  for (const key of TUI_THEME_COLOR_KEYS) {
    tuiTheme[key] = theme.colors[key];
  }
}
