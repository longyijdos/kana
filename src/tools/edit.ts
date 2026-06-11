import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./tool";
import { resolveExistingWorkspaceFile } from "./workspace-path";

export const editParameters = Type.Object({
  path: Type.String({
    description: "Existing file path to edit, relative to the workspace root or absolute.",
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
      default: false,
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

      const filePath = await resolveExistingWorkspaceFile(root, args.path);
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

function formatEditContent(result: EditToolResult): string {
  return [
    `edited: ${result.path}`,
    `replacements: ${result.replacements}`,
    `bytes: ${result.bytesWritten}`,
  ].join("\n");
}
