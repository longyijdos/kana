import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { Tool, ToolContext } from "./tool";
import { resolveExistingWorkspacePath } from "./workspace-path";

export const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LIMIT = 2000;
export const DEFAULT_GREP_INCLUDE = "**/*";

export const grepParameters = Type.Object({
  pattern: Type.String({
    minLength: 1,
    description: "JavaScript regular expression to search for. Use unescaped | for alternation.",
  }),
  path: Type.Optional(
    Type.String({
      default: ".",
      description: "File or directory path to search, relative to the workspace root or absolute.",
    }),
  ),
  include: Type.Optional(
    Type.String({
      default: DEFAULT_GREP_INCLUDE,
      description:
        'Relative file glob used when path is a directory, such as "**/*.ts" or "src/**/*.md".',
    }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Treat pattern as literal text instead of a regular expression.",
    }),
  ),
  caseSensitive: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Whether matching is case-sensitive.",
    }),
  ),
  includeHidden: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Whether to include dotfiles and files under dot-directories.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_GREP_LIMIT,
      default: DEFAULT_GREP_LIMIT,
      description: "Maximum number of matching lines to return.",
    }),
  ),
});

type GrepToolMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
};

export type GrepToolResult = {
  path: string;
  pattern: string;
  literal: boolean;
  caseSensitive: boolean;
  include: string | undefined;
  matches: GrepToolMatch[];
  filesSearched: number;
  truncated: boolean;
};

export type GrepToolOptions = {
  root?: string;
};

type SearchFile = {
  absolutePath: string;
  relativePath: string;
};

export function createGrepTool(
  options: GrepToolOptions = {},
): Tool<typeof grepParameters, GrepToolResult> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "grep",
    description:
      "Search text file contents with a regular expression. Prefer this over bash grep or grep piped to head for content search.",
    parameters: grepParameters,
    execution: {
      concurrency: "parallel",
    },
    execute: async (args, context) => {
      const target = await resolveExistingWorkspacePath(root, args.path ?? ".");
      const pattern = args.pattern.trim();
      const literal = args.literal ?? false;
      const caseSensitive = args.caseSensitive ?? true;
      const limit = clampLimit(args.limit ?? DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
      const includeHidden = args.includeHidden ?? false;
      const include = target.type === "directory" ? readRelativeGlob(args.include) : undefined;
      const matcher = createMatcher(pattern, { literal, caseSensitive });
      const files = await collectSearchFiles(
        target,
        include ?? DEFAULT_GREP_INCLUDE,
        includeHidden,
      );
      const matches: GrepToolMatch[] = [];
      let filesSearched = 0;
      let truncated = false;

      for (const file of files) {
        throwIfAborted(context);

        const content = await readFile(file.absolutePath, "utf8");

        if (content.includes("\0")) {
          continue;
        }

        filesSearched += 1;

        for (const match of searchFile(file.relativePath, content, matcher)) {
          matches.push(match);

          if (matches.length > limit) {
            truncated = true;
            matches.pop();
            break;
          }
        }

        if (truncated) {
          break;
        }
      }

      const result: GrepToolResult = {
        path: target.relativePath,
        pattern,
        literal,
        caseSensitive,
        include,
        matches,
        filesSearched,
        truncated,
      };

      return {
        content: formatGrepContent(result),
        result,
      };
    },
  };
}

function readRelativeGlob(pattern: string | undefined): string {
  const normalized = (pattern ?? DEFAULT_GREP_INCLUDE).trim();

  if (
    !normalized ||
    normalized.includes("\0") ||
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    hasParentPathSegment(normalized)
  ) {
    throw new Error("Invalid grep include pattern.");
  }

  return normalized;
}

function hasParentPathSegment(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/).some((segment) => segment === "..");
}

async function collectSearchFiles(
  target: Awaited<ReturnType<typeof resolveExistingWorkspacePath>>,
  include: string,
  includeHidden: boolean,
): Promise<SearchFile[]> {
  if (target.type === "file") {
    return [
      {
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
      },
    ];
  }

  const glob = new Bun.Glob(include);
  const files: SearchFile[] = [];

  for await (const relativePath of glob.scan({
    cwd: target.absolutePath,
    dot: includeHidden,
    onlyFiles: true,
  })) {
    const absolutePath = path.join(target.absolutePath, relativePath);
    const stats = await lstat(absolutePath);

    if (!stats.isFile()) {
      continue;
    }

    files.push({
      absolutePath,
      relativePath: joinWorkspacePath(target.relativePath, relativePath),
    });
  }

  return files.sort(compareSearchFiles);
}

function createMatcher(
  pattern: string,
  options: { literal: boolean; caseSensitive: boolean },
): RegExp {
  if (!pattern) {
    throw new Error("Grep pattern is required.");
  }

  try {
    return new RegExp(
      options.literal ? escapeRegExp(pattern) : pattern,
      options.caseSensitive ? "" : "i",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Invalid grep pattern: ${message}`);
  }
}

function searchFile(relativePath: string, content: string, matcher: RegExp): GrepToolMatch[] {
  return splitLines(content).flatMap((line, index) => {
    const match = matcher.exec(line);

    if (!match) {
      return [];
    }

    return [
      {
        path: relativePath,
        line: index + 1,
        column: match.index + 1,
        text: line,
      },
    ];
  });
}

function splitLines(content: string): string[] {
  if (!content) {
    return [];
  }

  const lines = content.split(/\r?\n/);

  if (lines.at(-1) === "" && /\r?\n$/.test(content)) {
    lines.pop();
  }

  return lines;
}

function compareSearchFiles(left: SearchFile, right: SearchFile): number {
  return left.relativePath.localeCompare(right.relativePath, "en");
}

function clampLimit(limit: number, max: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

function joinWorkspacePath(basePath: string, childPath: string): string {
  return basePath === "." ? childPath : path.join(basePath, childPath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function throwIfAborted(context: ToolContext): void {
  if (context.signal?.aborted) {
    throw new Error("Grep aborted.");
  }
}

function formatGrepContent(result: GrepToolResult): string {
  return [
    `path: ${result.path}`,
    `pattern: ${result.pattern}`,
    result.include ? `include: ${result.include}` : undefined,
    `matches: ${result.matches.length}`,
    `filesSearched: ${result.filesSearched}`,
    `truncated: ${result.truncated}`,
    "",
    ...result.matches.map((match) => `${match.path}:${match.line}:${match.column}:${match.text}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
