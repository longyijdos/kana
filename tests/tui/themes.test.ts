import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getKanaConfigPaths } from "@/kana";
import { applyTuiTheme, tuiTheme } from "../../src/tui/theme";
import {
  KANA_DARK_TUI_THEME,
  KANA_LIGHT_TUI_THEME,
  loadTuiTheme,
  parseUserTuiTheme,
  TUI_THEME_COLOR_KEYS,
} from "../../src/tui/themes";
import { cleanupTempKanaHomes, createTempKanaHomeEnv } from "../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

describe("TUI themes", () => {
  test("provides paired GitHub Default themes", () => {
    expect(KANA_DARK_TUI_THEME).toMatchObject({
      name: "kana-dark",
      source: "built-in",
      syntaxTheme: "github-dark-default",
      colors: {
        assistant: [230, 237, 243],
        user: [88, 166, 255],
        toolSuccess: [63, 185, 80],
        error: [255, 123, 114],
      },
    });
    expect(KANA_LIGHT_TUI_THEME).toMatchObject({
      name: "kana-light",
      source: "built-in",
      syntaxTheme: "github-light-default",
      colors: {
        assistant: [31, 35, 40],
        user: [9, 105, 218],
        toolSuccess: [26, 127, 55],
        error: [207, 34, 46],
      },
    });
  });

  test("fixes the active palette after startup application", () => {
    applyTuiTheme(KANA_DARK_TUI_THEME);

    expect(tuiTheme).toBe(KANA_DARK_TUI_THEME.colors);
    expect(() => applyTuiTheme(KANA_LIGHT_TUI_THEME)).toThrow(
      "The TUI theme is already fixed for this process.",
    );
  });

  test("loads only the selected user theme from KANA_HOME", () => {
    const env = createTempKanaHomeEnv();
    const { themesDirectory } = getKanaConfigPaths(env);
    mkdirSync(themesDirectory, { recursive: true });
    writeFileSync(path.join(themesDirectory, "broken.json"), "{");
    writeFileSync(
      path.join(themesDirectory, "ocean.json"),
      `${JSON.stringify(themeDocument({ assistant: "#123AbC" }))}\n`,
    );

    const theme = loadTuiTheme("ocean", env);

    expect(theme.name).toBe("ocean");
    expect(theme.source).toBe("user");
    expect(theme.syntaxTheme).toBe("tokyo-night");
    expect(theme.colors.assistant).toEqual([18, 58, 188]);
  });

  test("reserves built-in names without reading a same-named user file", () => {
    const env = createTempKanaHomeEnv();
    const { themesDirectory } = getKanaConfigPaths(env);
    mkdirSync(themesDirectory, { recursive: true });
    writeFileSync(path.join(themesDirectory, "kana-light.json"), "{");

    expect(loadTuiTheme("kana-dark", env)).toBe(KANA_DARK_TUI_THEME);
    expect(loadTuiTheme("kana-light", env)).toBe(KANA_LIGHT_TUI_THEME);
  });

  test("does not confuse object prototype names with built-in themes", () => {
    const env = createTempKanaHomeEnv();
    const { themesDirectory } = getKanaConfigPaths(env);
    mkdirSync(themesDirectory, { recursive: true });
    writeFileSync(
      path.join(themesDirectory, "constructor.json"),
      `${JSON.stringify(themeDocument())}\n`,
    );

    expect(loadTuiTheme("constructor", env).source).toBe("user");
  });

  test("rejects malformed JSON and missing user themes with their paths", () => {
    const env = createTempKanaHomeEnv();
    const { themesDirectory } = getKanaConfigPaths(env);
    mkdirSync(themesDirectory, { recursive: true });
    writeFileSync(path.join(themesDirectory, "broken.json"), "{");

    expect(() => loadTuiTheme("broken", env)).toThrow(
      `Failed to parse TUI theme broken from ${path.join(themesDirectory, "broken.json")}.`,
    );
    expect(() => loadTuiTheme("missing", env)).toThrow(
      `Failed to read TUI theme missing from ${path.join(themesDirectory, "missing.json")}.`,
    );
  });

  test.each(["", ".", "..", "../ocean", "ocean/dark", "Ocean", "-ocean"])(
    "rejects unsafe theme name %j before reading the filesystem",
    (name) => {
      expect(() => loadTuiTheme(name, createTempKanaHomeEnv())).toThrow(
        `Invalid TUI theme name: ${name}.`,
      );
    },
  );

  test("requires every semantic color", () => {
    const document = themeDocument();
    delete document.colors.markdownText;

    expect(() => parseUserTuiTheme("incomplete", document)).toThrow(
      "TUI theme incomplete.colors.markdownText is required.",
    );
  });

  test("rejects invalid colors, unsupported syntax themes, and unknown fields", () => {
    expect(() => parseUserTuiTheme("invalid-color", themeDocument({ assistant: "red" }))).toThrow(
      "TUI theme invalid-color.colors.assistant must use #rrggbb format.",
    );
    expect(() =>
      parseUserTuiTheme("invalid-syntax", {
        ...themeDocument(),
        syntaxTheme: "not-a-shiki-theme",
      }),
    ).toThrow("TUI theme invalid-syntax.syntaxTheme must name a bundled Shiki theme.");
    expect(() =>
      parseUserTuiTheme("unknown", {
        ...themeDocument(),
        extra: true,
      }),
    ).toThrow("TUI theme unknown contains unknown field extra.");
  });
});

type ThemeDocument = {
  syntaxTheme: string;
  colors: Record<string, string>;
};

function themeDocument(colors: Record<string, string> = {}): ThemeDocument {
  return {
    syntaxTheme: "tokyo-night",
    colors: {
      ...Object.fromEntries(TUI_THEME_COLOR_KEYS.map((key) => [key, "#010203"])),
      ...colors,
    },
  };
}
