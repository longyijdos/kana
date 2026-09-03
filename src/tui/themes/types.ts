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

// shiki exports BundledTheme as a type-only union, so an unsupported syntax
// theme name is a compile-time error for built-in specs and a runtime
// validation error for user JSON.
export type TuiSyntaxTheme = BundledTheme;

export type TuiTheme = {
  name: string;
  syntaxTheme: TuiSyntaxTheme;
  colors: TuiThemeColors;
};
