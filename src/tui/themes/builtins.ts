import type { ResolvedTuiTheme } from "./types";

export const KANA_TUI_THEME = {
  name: "kana",
  source: "built-in",
  syntaxTheme: "tokyo-night",
  colors: {
    assistant: [169, 177, 214],
    markdownText: [169, 177, 214],
    markdownHeading: [125, 207, 255],
    markdownQuote: [120, 124, 153],
    markdownRule: [54, 59, 84],
    markdownTable: [169, 177, 214],
    markdownCodeBlock: [169, 177, 214],
    markdownInlineCode: [224, 175, 104],
    user: [122, 162, 247],
    userMessageText: [192, 202, 245],
    shortcutHint: [187, 154, 247],
    command: [157, 124, 216],
    commandSelected: [187, 154, 247],
    bottomTitle: [125, 207, 255],
    muted: [120, 124, 153],
    model: [122, 162, 247],
    contextUsage: [115, 218, 202],
    cwd: [120, 124, 153],
    toolActive: [224, 175, 104],
    toolSuccess: [158, 206, 106],
    toolOutput: [154, 165, 206],
    error: [247, 118, 142],
    usageInput: [122, 162, 247],
    usageCache: [115, 218, 202],
    usageOutput: [158, 206, 106],
    usageReasoning: [187, 154, 247],
    usageWarning: [255, 158, 100],
    usageMuted: [81, 89, 125],
    statusIdle: [169, 177, 214],
    diffDeleteBackground: [52, 33, 43],
    diffInsertBackground: [31, 44, 56],
    welcomeBorder: [66, 70, 93],
    welcomeTitle: [125, 207, 255],
    welcomeMuted: [120, 124, 153],
    welcomeText: [169, 177, 214],
  },
} satisfies ResolvedTuiTheme;

const BUILT_IN_TUI_THEMES = new Map<string, ResolvedTuiTheme>([
  [KANA_TUI_THEME.name, KANA_TUI_THEME],
]);

export function getBuiltInTuiTheme(name: string): ResolvedTuiTheme | undefined {
  return BUILT_IN_TUI_THEMES.get(name);
}
