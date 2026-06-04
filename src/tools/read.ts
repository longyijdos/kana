import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./tool";

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 2000;

export const readParameters = Type.Object({
  path: Type.String({
    description: "File path to read, relative to the workspace root or absolute within it.",
  }),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "1-based line number to start reading from.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_READ_LIMIT,
      description: "Maximum number of lines to read.",
    }),
  ),
});

export type ReadToolResult = {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
};

export type ReadToolOptions = {
  root?: string;
};

export function createReadTool(options: ReadToolOptions = {}): Tool<
  typeof readParameters,
  ReadToolResult
> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "read",
    description:
      "Read a text file inside the workspace. Use offset and limit to inspect large files in chunks.",
    parameters: readParameters,
    execute: async (args) => {
      const filePath = await resolveWorkspaceFile(root, args.path);
      const content = await readFile(filePath.absolutePath, "utf8");
      const lines = splitLines(content);
      const offset = args.offset ?? 1;
      const limit = args.limit ?? DEFAULT_READ_LIMIT;
      const startIndex = Math.max(offset - 1, 0);
      const selectedLines = lines.slice(startIndex, startIndex + limit);
      const startLine = offset;
      const endLine = selectedLines.length
        ? startLine + selectedLines.length - 1
        : startLine - 1;
      const selectedContent = selectedLines.join("\n");
      const result: ReadToolResult = {
        path: filePath.relativePath,
        content: selectedContent,
        startLine,
        endLine,
        totalLines: lines.length,
        truncated: endLine < lines.length,
      };

      return {
        content: formatReadContent(result),
        result,
      };
    },
  };
}

async function resolveWorkspaceFile(
  root: string,
  inputPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  if (!inputPath || inputPath.includes("\0")) {
    throw new Error("Invalid file path.");
  }

  const rootPath = await realpath(root);
  const requestedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootPath, inputPath);
  const absolutePath = await realpath(requestedPath);

  if (!isInsideDirectory(rootPath, absolutePath)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }

  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${inputPath}`);
  }

  return {
    absolutePath,
    relativePath: path.relative(rootPath, absolutePath) || ".",
  };
}

function isInsideDirectory(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
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

function formatReadContent(result: ReadToolResult): string {
  return [
    `path: ${result.path}`,
    `lines: ${result.startLine}-${result.endLine} of ${result.totalLines}`,
    `truncated: ${result.truncated}`,
    "",
    result.content,
  ].join("\n");
}
