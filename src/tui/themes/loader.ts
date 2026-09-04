import { readFileSync } from "node:fs";
import path from "node:path";
import { getKanaConfigPaths, isKanaTuiThemeName } from "@/kana";
import { getBuiltInTuiTheme } from "./builtins";
import { parseUserTuiTheme } from "./parser";
import type { ResolvedTuiTheme } from "./types";

export function loadTuiTheme(name: string, env: NodeJS.ProcessEnv = process.env): ResolvedTuiTheme {
  if (!isKanaTuiThemeName(name)) {
    throw new Error(`Invalid TUI theme name: ${name}.`);
  }

  const builtIn = getBuiltInTuiTheme(name);
  if (builtIn) {
    return builtIn;
  }

  const themePath = path.join(getKanaConfigPaths(env).themesDirectory, `${name}.json`);
  let content: string;
  try {
    content = readFileSync(themePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read TUI theme ${name} from ${themePath}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse TUI theme ${name} from ${themePath}.`, { cause: error });
  }

  try {
    return {
      ...parseUserTuiTheme(name, parsed),
      source: "user",
    };
  } catch (error) {
    throw new Error(
      `Invalid TUI theme ${name} at ${themePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
