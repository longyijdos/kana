import { bundledThemes } from "shiki";
import { compileTuiTheme } from "./spec";
import type { TuiSyntaxTheme, TuiTheme, TuiThemeHexColors } from "./types";
import { isValidThemeName } from "./types";

// User theme files are untrusted JSON and go through this module before
// compilation. Built-in theme specs skip runtime syntax-theme validation
// because their syntaxTheme is compile-time narrowed to BundledTheme.

export function parseUserThemeJson(name: string, source: string): TuiTheme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Theme file "${name}.json" is not valid JSON.`);
  }

  if (!isValidThemeName(name)) {
    throw new Error(
      `Invalid theme file name "${name}"; theme names may only contain letters, digits, ".", "_", and "-".`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Theme file "${name}.json" must contain a JSON object.`);
  }

  const spec = parsed as Record<string, unknown>;
  const declaredName = spec.name;
  if (declaredName !== name) {
    throw new Error(
      `Theme file "${name}.json" declares name "${String(declaredName)}"; the file name must match its theme name.`,
    );
  }

  const colors = spec.colors;
  if (typeof colors !== "object" || colors === null || Array.isArray(colors)) {
    throw new Error(`Theme "${name}" must declare a "colors" table.`);
  }

  return compileTuiTheme({
    name,
    syntaxTheme: parseSyntaxTheme(spec.syntaxTheme, name),
    colors: colors as TuiThemeHexColors,
  });
}

function parseSyntaxTheme(value: unknown, name: string): TuiSyntaxTheme {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Theme "${name}" must declare a non-empty "syntaxTheme".`);
  }
  if (!isSupportedSyntaxTheme(value)) {
    throw new Error(
      `Theme "${name}" uses unsupported syntax theme "${value}". Supported themes: ${BUNDLED_SYNTAX_THEMES.join(", ")}.`,
    );
  }
  return value;
}

function isSupportedSyntaxTheme(value: string): value is TuiSyntaxTheme {
  return BUNDLED_SYNTAX_THEMES.includes(value);
}

const BUNDLED_SYNTAX_THEMES = Object.keys(bundledThemes);
