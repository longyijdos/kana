import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getKanaConfigPaths } from "@/kana";
import { applyTuiTheme, tuiTheme } from "../../src/tui/theme";
import {
  KANA_TUI_THEME,
  loadTuiTheme,
  parseUserTuiTheme,
  TUI_THEME_COLOR_KEYS,
} from "../../src/tui/themes";
import { cleanupTempKanaHomes, createTempKanaHomeEnv } from "../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

describe("TUI themes", () => {
  test("uses the Tokyo Night palette and syntax highlighting by default", () => {
    expect(KANA_TUI_THEME).toEqual({
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
    });
  });

  test("fixes the active palette after startup application", () => {
    applyTuiTheme(KANA_TUI_THEME);

    expect(tuiTheme).toBe(KANA_TUI_THEME.colors);
    expect(() => applyTuiTheme(KANA_TUI_THEME)).toThrow(
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
    writeFileSync(path.join(themesDirectory, "kana.json"), "{");

    expect(loadTuiTheme("kana", env)).toBe(KANA_TUI_THEME);
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
