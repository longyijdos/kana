import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyTuiTheme, tuiTheme } from "../../src/tui/theme";
import { getBuiltInTheme } from "../../src/tui/themes/builtins";
import {
  availableThemeNames,
  listUserThemeNames,
  resolveTuiTheme,
} from "../../src/tui/themes/loader";
import { TUI_THEME_COLOR_KEYS } from "../../src/tui/themes/types";
import { parseUserThemeJson } from "../../src/tui/themes/validate";

function makeEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, KANA_HOME: home };
}

function writeTheme(home: string, name: string, content: string): void {
  const directory = path.join(home, "themes");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), content);
}

let tempHome: string;

beforeEach(() => {
  tempHome = path.join(os.tmpdir(), `kana-theme-test-${process.pid}-${Date.now()}`);
  mkdirSync(tempHome, { recursive: true });
});

afterEach(() => {
  Bun.spawnSync(["rm", "-rf", tempHome]);
  applyTuiTheme(getBuiltInTheme("kana"));
});

const VALID_THEME = (name: string, syntaxTheme = "dark-plus"): string =>
  JSON.stringify({
    name,
    syntaxTheme,
    colors: Object.fromEntries(TUI_THEME_COLOR_KEYS.map((key) => [key, "#123456"])),
  });

describe("TUI theme built-in", () => {
  test("built-in kana theme resolves and mirrors the current palette", () => {
    const theme = resolveTuiTheme("kana", makeEnv(tempHome));

    expect(theme.name).toBe("kana");
    expect(theme.syntaxTheme).toBe("dark-plus");
    expect(Object.keys(theme.colors).sort()).toEqual([...TUI_THEME_COLOR_KEYS].sort());
  });

  test("built-in kana theme preserves the default appearance", () => {
    const theme = resolveTuiTheme("kana", makeEnv(tempHome));
    expect(theme.colors.assistant).toEqual([222, 226, 230]);
    expect(theme.colors.error).toEqual([244, 112, 103]);
    expect(theme.colors.welcomeTitle).toEqual([105, 208, 196]);
  });
});

describe("TUI theme resolution", () => {
  test("applies a user theme from the KANA_HOME themes directory", () => {
    writeTheme(tempHome, "tokyo-night", VALID_THEME("tokyo-night", "tokyo-night"));
    const theme = resolveTuiTheme("tokyo-night", makeEnv(tempHome));

    expect(theme.name).toBe("tokyo-night");
    expect(theme.syntaxTheme).toBe("tokyo-night");

    applyTuiTheme(theme);
    expect(tuiTheme.assistant).toEqual([18, 52, 86]);
  });

  test("rejects an unknown theme with available names", () => {
    writeTheme(tempHome, "catppuccin", VALID_THEME("catppuccin", "catppuccin-mocha"));
    expect(() => resolveTuiTheme("missing", makeEnv(tempHome))).toThrow(
      'Unknown TUI theme "missing"',
    );
  });

  test("rejects a user theme file whose name does not match its declared name", () => {
    writeTheme(tempHome, "renamed", VALID_THEME("original"));
    expect(() => resolveTuiTheme("renamed", makeEnv(tempHome))).toThrow(/declares name "original"/);
  });

  test("rejects a user theme with an unsupported syntax theme", () => {
    writeTheme(tempHome, "bad-syntax", VALID_THEME("bad-syntax", "not-a-shiki-theme"));
    expect(() => resolveTuiTheme("bad-syntax", makeEnv(tempHome))).toThrow(
      'unsupported syntax theme "not-a-shiki-theme"',
    );
  });

  test("rejects a user theme missing color keys", () => {
    const partial = JSON.parse(VALID_THEME("partial")) as Record<string, unknown>;
    const colors = partial.colors as Record<string, string>;
    delete colors.markdownHeading;
    writeTheme(tempHome, "partial", JSON.stringify(partial));

    expect(() => resolveTuiTheme("partial", makeEnv(tempHome))).toThrow(
      /missing color "markdownHeading"/,
    );
  });

  test("rejects invalid JSON with a clear error", () => {
    writeTheme(tempHome, "broken", "{ not json");
    expect(() => resolveTuiTheme("broken", makeEnv(tempHome))).toThrow(
      'Theme file "broken.json" is not valid JSON.',
    );
  });

  test("parseUserThemeJson validates hex color format", () => {
    const theme = JSON.parse(VALID_THEME("hex")) as Record<string, unknown>;
    (theme.colors as Record<string, string>).user = "not-a-hex";
    expect(() => parseUserThemeJson("hex", JSON.stringify(theme))).toThrow(
      /must be a "#rrggbb" hex color/,
    );
  });

  test("getBuiltInTheme returns the same compiled theme", () => {
    expect(getBuiltInTheme("kana")).toBe(getBuiltInTheme("kana"));
  });
});

describe("TUI theme names", () => {
  test("rejects names that could escape the themes directory", () => {
    for (const name of ["../escape", "..", "a/b", "a\\b", "", "  "]) {
      expect(() => resolveTuiTheme(name, makeEnv(tempHome))).toThrow(/Invalid theme name/);
    }
  });

  test("accepts dotted, dashed, and underscored names", () => {
    writeTheme(tempHome, "my.theme-v2_x", VALID_THEME("my.theme-v2_x"));
    expect(resolveTuiTheme("my.theme-v2_x", makeEnv(tempHome)).name).toBe("my.theme-v2_x");
  });
});

describe("available user themes", () => {
  test("lists only themes that load and validate", () => {
    writeTheme(tempHome, "valid", VALID_THEME("valid", "tokyo-night"));
    writeTheme(tempHome, "broken-json", "{ nope");
    writeTheme(tempHome, "bad-name", VALID_THEME("other-name"));
    writeTheme(tempHome, "not-a-theme.txt", "{}");

    expect(listUserThemeNames(tempHome)).toEqual(["valid"]);
  });

  test("availableThemeNames combines built-ins with valid user themes", () => {
    writeTheme(tempHome, "valid", VALID_THEME("valid", "tokyo-night"));
    writeTheme(tempHome, "broken-json", "{ nope");

    expect(availableThemeNames(tempHome)).toEqual(["kana", "valid"]);
  });

  test("empty themes directory yields only built-ins", () => {
    expect(availableThemeNames(tempHome)).toEqual(["kana"]);
  });
});
