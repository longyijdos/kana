import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getKanaConfigPaths } from "@/kana";

import { BUILT_IN_THEME_NAMES, getBuiltInTheme } from "./builtins";
import type { TuiTheme } from "./types";
import { isValidThemeName } from "./types";
import { parseUserThemeJson } from "./validate";

// Theme loading and resolution. Built-in themes come from builtins.ts; user
// themes live in <KANA_HOME>/themes/<name>.json and are validated on load.

const USER_THEMES_DIRECTORY = "themes";

// Listing resolves every candidate so "available" only ever means valid,
// loadable themes. Resolution of a single theme stays lazy and reports the
// specific file error instead of silently treating it as missing.
function listUserThemes(home: string): TuiTheme[] {
  const directory = path.join(home, USER_THEMES_DIRECTORY);

  if (!existsSync(directory)) {
    return [];
  }

  const themes: TuiTheme[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const name = entry.name.slice(0, -".json".length);
    if (!isValidThemeName(name)) {
      continue;
    }

    try {
      themes.push(loadUserTheme(name, path.join(directory, entry.name)));
    } catch {
      // A malformed theme file is not an available theme.
    }
  }

  return themes.sort((left, right) => left.name.localeCompare(right.name));
}

export function listUserThemeNames(home: string): string[] {
  return listUserThemes(home).map((theme) => theme.name);
}

export function availableThemeNames(home: string): string[] {
  return [...BUILT_IN_THEME_NAMES, ...listUserThemeNames(home)];
}

export function resolveTuiTheme(name: string, env: NodeJS.ProcessEnv = process.env): TuiTheme {
  if (!isValidThemeName(name)) {
    throw new Error(
      `Invalid theme name "${name}"; theme names may only contain letters, digits, ".", "_", and "-".`,
    );
  }

  if (BUILT_IN_THEME_NAMES.includes(name)) {
    return getBuiltInTheme(name);
  }

  const { home } = getKanaConfigPaths(env);
  const userFilePath = path.join(home, USER_THEMES_DIRECTORY, `${name}.json`);
  if (existsSync(userFilePath)) {
    return loadUserTheme(name, userFilePath);
  }

  throw new Error(
    `Unknown TUI theme "${name}". Available themes: ${availableThemeNames(home).join(", ")}.`,
  );
}

function loadUserTheme(name: string, filePath: string): TuiTheme {
  return parseUserThemeJson(name, readFileSync(filePath, "utf8"));
}
