import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./tool";

export const editParameters = Type.Object({
  path: Type.String({
    description: "Existing file path to edit, relative to the workspace root or absolute within it.",
  }),
  oldText: Type.String({
    minLength: 1,
    description: "Exact text to replace. Must be non-empty.",
  }),
  newText: Type.String({
    description: "Replacement text.",
  }),
  replaceAll: Type.Optional(
    Type.Boolean({
      description: "Replace every occurrence. Defaults to false, which requires exactly one match.",
    }),
  ),
});

export type EditToolResult = {
  path: string;
  replacements: number;
  bytesWritten: number;
  oldText: string;
  newText: string;
};

export type EditToolOptions = {
  root?: string;
};

export function createEditTool(options: EditToolOptions = {}): Tool<
  typeof editParameters,
  EditToolResult
> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "edit",
    description:
      "Edit an existing text file by exact string replacement. By default oldText must match exactly once.",
    parameters: editParameters,
    execute: async (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Edit aborted.");
      }

      const filePath = await resolveWorkspaceFile(root, args.path);
      const content = await readFile(filePath.absolutePath, "utf8");
      const replacements = countOccurrences(content, args.oldText);

      if (replacements === 0) {
        throw new Error(`Text not found in file: ${args.path}`);
      }

      if (!args.replaceAll && replacements > 1) {
        throw new Error(
          `Text appears ${replacements} times in file; provide a more specific oldText or set replaceAll to true.`,
        );
      }

      const nextContent = args.replaceAll
        ? content.split(args.oldText).join(args.newText)
        : content.replace(args.oldText, args.newText);

      if (context.signal?.aborted) {
        throw new Error("Edit aborted.");
      }

      await writeFile(filePath.absolutePath, nextContent, "utf8");

      const appliedReplacements = args.replaceAll ? replacements : 1;
      const result: EditToolResult = {
        path: filePath.relativePath,
        replacements: appliedReplacements,
        bytesWritten: Buffer.byteLength(nextContent, "utf8"),
        oldText: args.oldText,
        newText: args.newText,
      };

      return {
        content: formatEditContent(result),
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

function countOccurrences(content: string, search: string): number {
  if (!search) {
    return 0;
  }

  let count = 0;
  let index = 0;

  for (;;) {
    const nextIndex = content.indexOf(search, index);

    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    index = nextIndex + search.length;
  }
}

function isInsideDirectory(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function formatEditContent(result: EditToolResult): string {
  return [
    `edited: ${result.path}`,
    `replacements: ${result.replacements}`,
    `bytes: ${result.bytesWritten}`,
  ].join("\n");
}
