import type { BundledTheme } from "shiki";

// Canonical semantic color keys for the Kana TUI. Render code reads these
// through the active theme; the set must stay exhaustive so themes fully
// describe the non-brand appearance. Brand logo pixels live in welcome-logo.ts
// and are intentionally absent here.

export const TUI_THEME_COLOR_KEYS = [
  "assistant",
  "markdownText",
  "markdownHeading",
  "markdownQuote",
  "markdownRule",
  "markdownTable",
  "markdownCodeBlock",
  "markdownInlineCode",
  "user",
  "userMessageText",
  "shortcutHint",
  "command",
  "commandSelected",
  "bottomTitle",
  "muted",
  "model",
  "contextUsage",
  "cwd",
  "toolActive",
  "toolSuccess",
  "toolOutput",
  "error",
  "usageInput",
  "usageCache",
  "usageOutput",
  "usageReasoning",
  "usageWarning",
  "usageMuted",
  "statusIdle",
  "diffDeleteBackground",
  "diffInsertBackground",
  "welcomeBorder",
  "welcomeTitle",
  "welcomeMuted",
  "welcomeText",
] as const;

type TuiThemeColorKey = (typeof TUI_THEME_COLOR_KEYS)[number];

export type RgbTuple = readonly [red: number, green: number, blue: number];

export type TuiThemeColors = {
  [key in TuiThemeColorKey]: RgbTuple;
};

// Hex form of the semantic palette. Built-in theme specs use this so missing
// keys are compile-time errors; user JSON is validated at runtime instead.
export type TuiThemeHexColors = Record<TuiThemeColorKey, string>;

// shiki exports BundledTheme as a type-only union, so an unsupported syntax
// theme name is a compile-time error for built-in specs and a runtime
// validation error for user JSON.
export type TuiSyntaxTheme = BundledTheme;

export type TuiTheme = {
  name: string;
  syntaxTheme: TuiSyntaxTheme;
  colors: TuiThemeColors;
};

// Theme names come from [tui].theme or user file names and must be safe to
// use as a single path segment under the themes directory. Dots are allowed
// inside names but "." and ".." are not valid theme names themselves.
const TUI_THEME_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const TUI_RESERVED_THEME_NAMES = new Set([".", ".."]);

export function isValidThemeName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    !TUI_RESERVED_THEME_NAMES.has(name) &&
    TUI_THEME_NAME_PATTERN.test(name)
  );
}
