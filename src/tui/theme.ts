import { KANA_TUI_THEME } from "./themes/builtins";
import type { TuiPalette, TuiTheme } from "./themes/types";

export let tuiTheme: TuiPalette = KANA_TUI_THEME.colors;
let configured = false;

export function applyTuiTheme(theme: TuiTheme): void {
  if (configured) {
    throw new Error("The TUI theme is already fixed for this process.");
  }
  configured = true;
  tuiTheme = theme.colors;
}
