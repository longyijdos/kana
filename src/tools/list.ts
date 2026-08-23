import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "./tool";
import { resolveExistingWorkspaceDirectory } from "./workspace-path";

export const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 2000;

export const listParameters = Type.Object({
  path: Type.Optional(
    Type.String({
      default: ".",
      description: "Directory path to list, relative to the workspace root or absolute.",
    }),
  ),
  includeHidden: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Whether to include entries whose names start with a dot.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIST_LIMIT,
      default: DEFAULT_LIST_LIMIT,
      description: "Maximum number of entries to return.",
    }),
  ),
});

type ListEntryType = "file" | "directory" | "symlink" | "other";

type ListToolEntry = {
  name: string;
  path: string;
  type: ListEntryType;
  size: number;
};

export type ListToolResult = {
  path: string;
  entries: ListToolEntry[];
  totalEntries: number;
  truncated: boolean;
};

export type ListToolOptions = {
  root?: string;
};

export function createListTool(
  options: ListToolOptions = {},
): Tool<typeof listParameters, ListToolResult> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "list",
    description:
      "List the direct children of a directory. Prefer this over bash ls for file exploration.",
    parameters: listParameters,
    execution: {
      concurrency: "parallel",
    },
    execute: async (args) => {
      const directory = await resolveExistingWorkspaceDirectory(root, args.path ?? ".");
      const includeHidden = args.includeHidden ?? true;
      const limit = clampLimit(args.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const dirents = await readdir(directory.absolutePath, { withFileTypes: true });
      const visibleDirents = includeHidden
        ? dirents
        : dirents.filter((dirent) => !dirent.name.startsWith("."));
      const entries = await Promise.all(
        visibleDirents.map(async (dirent): Promise<ListToolEntry> => {
          const absolutePath = path.join(directory.absolutePath, dirent.name);
          const stats = await lstat(absolutePath);

          return {
            name: dirent.name,
            path: joinWorkspacePath(directory.relativePath, dirent.name),
            type: readEntryType(stats),
            size: stats.size,
          };
        }),
      );
      const sortedEntries = entries.sort(compareEntries);
      const selectedEntries = sortedEntries.slice(0, limit);
      const result: ListToolResult = {
        path: directory.relativePath,
        entries: selectedEntries,
        totalEntries: sortedEntries.length,
        truncated: selectedEntries.length < sortedEntries.length,
      };

      return {
        content: formatListContent(result),
        result,
      };
    },
  };
}

function readEntryType(stats: Awaited<ReturnType<typeof lstat>>): ListEntryType {
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

function compareEntries(left: ListToolEntry, right: ListToolEntry): number {
  return left.name.localeCompare(right.name, "en");
}

function clampLimit(limit: number, max: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

function joinWorkspacePath(basePath: string, childPath: string): string {
  return basePath === "." ? childPath : path.join(basePath, childPath);
}

function formatListContent(result: ListToolResult): string {
  return [
    `path: ${result.path}`,
    `entries: ${result.entries.length} of ${result.totalEntries}`,
    `truncated: ${result.truncated}`,
    "",
    ...result.entries.map((entry) => `${entry.type}\t${entry.size}\t${entry.path}`),
  ].join("\n");
}
