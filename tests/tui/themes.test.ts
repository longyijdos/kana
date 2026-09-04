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
  test("keeps the Kana palette and uses Tokyo Night syntax highlighting by default", () => {
    expect(KANA_TUI_THEME).toEqual({
      name: "kana",
      source: "built-in",
      syntaxTheme: "tokyo-night",
      colors: {
        assistant: [222, 226, 230],
        markdownText: [222, 226, 230],
        markdownHeading: [105, 208, 196],
        markdownQuote: [139, 148, 158],
        markdownRule: [75, 85, 99],
        markdownTable: [205, 213, 223],
        markdownCodeBlock: [205, 213, 223],
        markdownInlineCode: [229, 181, 103],
        user: [126, 166, 255],
        userMessageText: [222, 226, 230],
        shortcutHint: [192, 153, 224],
        command: [192, 153, 224],
        commandSelected: [213, 176, 245],
        bottomTitle: [105, 208, 196],
        muted: [139, 148, 158],
        model: [126, 166, 255],
        contextUsage: [105, 208, 196],
        cwd: [139, 148, 158],
        toolActive: [229, 181, 103],
        toolSuccess: [137, 209, 133],
        toolOutput: [156, 166, 178],
        error: [244, 112, 103],
        usageInput: [126, 166, 255],
        usageCache: [105, 208, 196],
        usageOutput: [137, 209, 133],
        usageReasoning: [192, 153, 224],
        usageWarning: [240, 171, 86],
        usageMuted: [92, 102, 116],
        statusIdle: [205, 213, 223],
        diffDeleteBackground: [70, 24, 24],
        diffInsertBackground: [18, 70, 38],
        welcomeBorder: [75, 85, 99],
        welcomeTitle: [105, 208, 196],
        welcomeMuted: [139, 148, 158],
        welcomeText: [222, 226, 230],
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
