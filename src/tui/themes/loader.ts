import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths } from "@/kana";

import type { TuiTheme } from "./types";
import { compileTuiTheme, parseUserThemeJson, type TuiThemeSpec } from "./validate";

// Built-in themes are embedded as compiled specs in this module. User themes
// live in ~/.kana/themes/<name>.json and share the same validation path, so
// both sources produce the same TuiTheme shape.

export function listUserThemeNames(home: string): string[] {
  const directory = path.join(home, "themes");

  if (!existsSync(directory)) {
    return [];
  }

  const names: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const name = entry.name.slice(0, -".json".length);
      if (name.trim() !== "") {
        names.push(name);
      }
    }
  }

  return names.sort();
}

export function resolveTuiTheme(name: string, env: NodeJS.ProcessEnv = process.env): TuiTheme {
  const builtIn = BUILT_IN_THEMES[name];

  if (builtIn !== undefined) {
    return builtIn;
  }

  const { home } = getKanaConfigPaths(env);
  const userFilePath = path.join(home, "themes", `${name}.json`);
  if (existsSync(userFilePath)) {
    return loadUserTheme(name, userFilePath);
  }

  throw new Error(
    `Unknown TUI theme "${name}". Available themes: ${availableThemeNames(home).join(", ")}.`,
  );
}

function availableThemeNames(home: string): string[] {
  return [...Object.keys(BUILT_IN_THEMES), ...listUserThemeNames(home)];
}

function loadUserTheme(name: string, filePath: string): TuiTheme {
  return parseUserThemeJson(name, readFileSync(filePath, "utf8"));
}

// Keep the current Kana appearance as the default theme. The spec is compiled
// through the same path as user themes so a palette typo would be caught
// identically in both sources.
const KANA_THEME_SPEC: TuiThemeSpec = {
  name: "kana",
  syntaxTheme: "dark-plus",
  colors: {
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
  },
};

const BUILT_IN_THEMES: Readonly<Record<string, TuiTheme>> = Object.freeze({
  kana: compileTuiTheme(KANA_THEME_SPEC),
});

export function getBuiltInTheme(name = "kana"): TuiTheme {
  const theme = BUILT_IN_THEMES[name];
  if (theme === undefined) {
    throw new Error(`Unknown built-in TUI theme "${name}".`);
  }
  return theme;
}
