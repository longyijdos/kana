import type { BundledLanguage, Highlighter, ThemedToken } from "shiki";
import { createHighlighter } from "shiki";
import type { TuiSyntaxTheme } from "../themes/types";

export type HighlightedCodeLine = Array<{
  text: string;
  color?: string;
}>;

// The upstream shell grammar mis-scopes the final character before `>` (for
// example, `<hash>`). Track jeff-hykin/better-shell-syntax#111 and #130
// instead of patching Shiki's generated grammar locally.
const SHIKI_LANGUAGES = [
  "bash",
  "css",
  "diff",
  "html",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "shellscript",
  "tsx",
  "typescript",
  "yaml",
] as const satisfies BundledLanguage[];

const LANGUAGE_ALIASES: Record<string, BundledLanguage> = {
  cjs: "javascript",
  console: "shellscript",
  js: "javascript",
  jsonc: "json",
  md: "markdown",
  py: "python",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  yml: "yaml",
  zsh: "shellscript",
};

let highlighter: Highlighter | undefined;
let highlighterPromise: Promise<void> | undefined;
const highlightedCodeCache = new Map<string, HighlightedCodeLine[]>();

// The syntax theme is fixed for the process lifetime: startup resolves the
// configured TUI theme and calls setSyntaxTheme before preloadSyntaxHighlighter
// creates the highlighter. Static use keeps the highlighted-code cache valid.
let activeSyntaxTheme: TuiSyntaxTheme = "dark-plus";

export function setSyntaxTheme(theme: TuiSyntaxTheme): void {
  if (highlighter) {
    throw new Error("setSyntaxTheme must run before preloadSyntaxHighlighter.");
  }
  activeSyntaxTheme = theme;
}

export function preloadSyntaxHighlighter(): Promise<void> {
  highlighterPromise ??= createHighlighter({
    themes: [activeSyntaxTheme],
    langs: [...SHIKI_LANGUAGES],
  }).then((nextHighlighter) => {
    highlighter = nextHighlighter;
  });

  return highlighterPromise;
}

export function highlightCodeSync(
  code: string,
  language: string | undefined,
): HighlightedCodeLine[] | undefined {
  if (!highlighter || !language) {
    return undefined;
  }

  const normalizedLanguage = normalizeLanguage(language);

  if (!normalizedLanguage) {
    return undefined;
  }

  const cacheKey = `${normalizedLanguage}\0${code}`;
  const cached = highlightedCodeCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const highlighted = highlighter
      .codeToTokensBase(code, {
        lang: normalizedLanguage,
        theme: activeSyntaxTheme,
      })
      .map((line) => line.map(formatToken));

    cacheHighlightedCode(cacheKey, highlighted);

    return highlighted;
  } catch {
    return undefined;
  }
}

export function inferCodeLanguage(filePath: string | undefined): string | undefined {
  const extension = filePath?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

  switch (extension) {
    case "bash":
    case "sh":
    case "zsh":
      return "bash";
    case "css":
    case "html":
    case "json":
    case "jsx":
    case "md":
    case "py":
    case "tsx":
    case "typescript":
    case "yaml":
      return extension;
    case "js":
      return "javascript";
    case "ts":
      return "typescript";
    case "yml":
      return "yaml";
    default:
      return undefined;
  }
}

function normalizeLanguage(language: string): BundledLanguage | undefined {
  const normalized = language.toLowerCase().trim();

  if (isSupportedLanguage(normalized)) {
    return normalized;
  }

  return LANGUAGE_ALIASES[normalized];
}

function isSupportedLanguage(value: string): value is BundledLanguage {
  return SHIKI_LANGUAGES.includes(value as (typeof SHIKI_LANGUAGES)[number]);
}

function formatToken(token: ThemedToken): HighlightedCodeLine[number] {
  return {
    text: token.content,
    color: token.color,
  };
}

function cacheHighlightedCode(key: string, value: HighlightedCodeLine[]): void {
  if (highlightedCodeCache.size >= 100) {
    const oldestKey = highlightedCodeCache.keys().next().value;

    if (oldestKey) {
      highlightedCodeCache.delete(oldestKey);
    }
  }

  highlightedCodeCache.set(key, value);
}
