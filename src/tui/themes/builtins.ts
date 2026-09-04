import { compileTuiTheme, type TuiThemeSpec } from "./spec";
import type { TuiTheme, TuiThemeHexColors } from "./types";

// Built-in theme definitions. Keeping them in a dedicated module (instead of
// loader.ts) lets theme.ts hold the active palette without dragging in the
// filesystem/user-theme loading stack.

const KANA_THEME_COLORS: TuiThemeHexColors = {
  assistant: "#dee2e6",
  markdownText: "#dee2e6",
  markdownHeading: "#69d0c4",
  markdownQuote: "#8b949e",
  markdownRule: "#4b5563",
  markdownTable: "#cdd5df",
  markdownCodeBlock: "#cdd5df",
  markdownInlineCode: "#e5b367",
  user: "#7ea6ff",
  userMessageText: "#dee2e6",
  shortcutHint: "#c099e0",
  command: "#c099e0",
  commandSelected: "#d5b0f5",
  bottomTitle: "#69d0c4",
  muted: "#8b949e",
  model: "#7ea6ff",
  contextUsage: "#69d0c4",
  cwd: "#8b949e",
  toolActive: "#e5b367",
  toolSuccess: "#89d185",
  toolOutput: "#9ca6b2",
  error: "#f47067",
  usageInput: "#7ea6ff",
  usageCache: "#69d0c4",
  usageOutput: "#89d185",
  usageReasoning: "#c099e0",
  usageWarning: "#f0ab56",
  usageMuted: "#5c6674",
  statusIdle: "#cdd5df",
  diffDeleteBackground: "#461818",
  diffInsertBackground: "#124626",
  welcomeBorder: "#4b5563",
  welcomeTitle: "#69d0c4",
  welcomeMuted: "#8b949e",
  welcomeText: "#dee2e6",
};

const BUILT_IN_THEME_SPECS: Readonly<Record<string, TuiThemeSpec>> = {
  kana: {
    name: "kana",
    syntaxTheme: "dark-plus",
    colors: KANA_THEME_COLORS,
  },
};

const BUILT_IN_THEMES: Readonly<Record<string, TuiTheme>> = Object.fromEntries(
  Object.entries(BUILT_IN_THEME_SPECS).map(([name, spec]) => [name, compileTuiTheme(spec)]),
);

export const BUILT_IN_THEME_NAMES: readonly string[] = Object.freeze(Object.keys(BUILT_IN_THEMES));

export function getBuiltInTheme(name: string): TuiTheme {
  const theme = BUILT_IN_THEMES[name];

  if (theme === undefined) {
    throw new Error(`Unknown built-in TUI theme "${name}".`);
  }

  return theme;
}
