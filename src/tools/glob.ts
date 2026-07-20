import { lstat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { Tool, ToolContext } from "./tool";
import { resolveExistingWorkspaceDirectory } from "./workspace-path";

const DEFAULT_GLOB_LIMIT = 200;
const MAX_GLOB_LIMIT = 2000;
const MAX_GLOB_DEPTH = 50;
const GLOB_ENTRY_TYPES = ["file", "directory", "any"] as const;

export const globParameters = Type.Object({
  cwd: Type.Optional(
    Type.String({
      default: ".",
      description: "Directory to search from, relative to the workspace root or absolute.",
    }),
  ),
  pattern: Type.String({
    minLength: 1,
    description: 'Relative glob pattern to match, such as "**/*", "**/*.md", or "src/**/*.ts".',
  }),
  type: Type.Optional(
    Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("any")], {
      default: "file",
      description: "Which matched path types to return.",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_GLOB_DEPTH,
      description: "Maximum path depth relative to cwd. Omit to search all depths.",
    }),
  ),
  includeHidden: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Whether to include dotfiles and entries under dot-directories.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_GLOB_LIMIT,
      default: DEFAULT_GLOB_LIMIT,
      description: "Maximum number of matches to return.",
    }),
  ),
});

export type GlobEntryType = "file" | "directory" | "symlink" | "other";

export type GlobToolMatch = {
  path: string;
  type: GlobEntryType;
  size: number;
};

export type GlobToolResult = {
  cwd: string;
  pattern: string;
  type: (typeof GLOB_ENTRY_TYPES)[number];
  matches: GlobToolMatch[];
  totalMatches: number;
  truncated: boolean;
};

export type GlobToolOptions = {
  root?: string;
};

export function createGlobTool(
  options: GlobToolOptions = {},
): Tool<typeof globParameters, GlobToolResult> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "glob",
    description:
      "Find file and directory paths with a relative glob pattern. Prefer this over bash find for file discovery.",
    parameters: globParameters,
    execute: async (args, context) => {
      const searchRoot = await resolveExistingWorkspaceDirectory(root, args.cwd ?? ".");
      const pattern = readRelativeGlobPattern(args.pattern);
      const type = args.type ?? "file";
      const includeHidden = args.includeHidden ?? false;
      const limit = clampLimit(args.limit ?? DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);
      const maxDepth = args.maxDepth;
      const glob = new Bun.Glob(pattern);
      const matches: GlobToolMatch[] = [];

      for await (const relativePath of glob.scan({
        cwd: searchRoot.absolutePath,
        dot: includeHidden,
        onlyFiles: false,
      })) {
        throwIfAborted(context);

        if (maxDepth !== undefined && pathDepth(relativePath) > maxDepth) {
          continue;
        }

        const match = await readMatch(
          searchRoot.relativePath,
          searchRoot.absolutePath,
          relativePath,
        );

        if (matchesType(match.type, type)) {
          matches.push(match);
        }
      }

      const sortedMatches = matches.sort(compareMatches);
      const selectedMatches = sortedMatches.slice(0, limit);
      const result: GlobToolResult = {
        cwd: searchRoot.relativePath,
        pattern,
        type,
        matches: selectedMatches,
        totalMatches: sortedMatches.length,
        truncated: selectedMatches.length < sortedMatches.length,
      };

      return {
        content: formatGlobContent(result),
        result,
      };
    },
  };
}

function readRelativeGlobPattern(pattern: string): string {
  const normalized = pattern.trim();

  if (
    !normalized ||
    normalized.includes("\0") ||
    path.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    hasParentPathSegment(normalized)
  ) {
    throw new Error("Invalid glob pattern.");
  }

  return normalized;
}

function hasParentPathSegment(inputPath: string): boolean {
  return inputPath.split(/[\\/]+/).some((segment) => segment === "..");
}

async function readMatch(
  cwd: string,
  absoluteCwd: string,
  relativePath: string,
): Promise<GlobToolMatch> {
  const absolutePath = path.join(absoluteCwd, relativePath);
  const stats = await lstat(absolutePath);

  return {
    path: joinWorkspacePath(cwd, relativePath),
    type: readEntryType(stats),
    size: stats.size,
  };
}

function readEntryType(stats: Awaited<ReturnType<typeof lstat>>): GlobEntryType {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }

  if (stats.isDirectory()) {
    return "directory";
  }

  if (stats.isFile()) {
    return "file";
  }

  return "other";
}

function matchesType(entryType: GlobEntryType, requestedType: GlobToolResult["type"]): boolean {
  if (requestedType === "any") {
    return true;
  }

  return entryType === requestedType;
}

function compareMatches(left: GlobToolMatch, right: GlobToolMatch): number {
  return left.path.localeCompare(right.path, "en");
}

function pathDepth(relativePath: string): number {
  return relativePath.split(/[\\/]+/).filter(Boolean).length;
}

function clampLimit(limit: number, max: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

function joinWorkspacePath(basePath: string, childPath: string): string {
  return basePath === "." ? childPath : path.join(basePath, childPath);
}

function throwIfAborted(context: ToolContext): void {
  if (context.signal?.aborted) {
    throw new Error("Glob aborted.");
  }
}

function formatGlobContent(result: GlobToolResult): string {
  return [
    `cwd: ${result.cwd}`,
    `pattern: ${result.pattern}`,
    `type: ${result.type}`,
    `matches: ${result.matches.length} of ${result.totalMatches}`,
    `truncated: ${result.truncated}`,
    "",
    ...result.matches.map((match) => `${match.type}\t${match.size}\t${match.path}`),
  ].join("\n");
}
