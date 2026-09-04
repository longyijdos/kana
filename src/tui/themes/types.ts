import type { BundledTheme } from "shiki";

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

export type TuiThemeColorKey = (typeof TUI_THEME_COLOR_KEYS)[number];
type TuiThemeColor = readonly [red: number, green: number, blue: number];
export type TuiPalette = Readonly<Record<TuiThemeColorKey, TuiThemeColor>>;

export type TuiTheme = {
  name: string;
  syntaxTheme: BundledTheme;
  colors: TuiPalette;
};

export type ResolvedTuiTheme = TuiTheme & {
  source: "built-in" | "user";
};
