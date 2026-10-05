import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveExistingWorkspaceFile } from "./workspace-path";

const editEntryParameters = strictObject({
  oldText: Type.String({
    minLength: 1,
    description: "Exact text to replace. Must match exactly once in the original file.",
  }),
  newText: Type.String({
    description: "Replacement text.",
  }),
});

export const editParameters = strictObject({
  path: Type.String({
    description: "Existing file path to edit, relative to the workspace root or absolute.",
  }),
  edits: Type.Array(editEntryParameters, {
    minItems: 1,
    description:
      "One or more exact, non-overlapping replacements. All edits are matched against the original file and applied atomically.",
  }),
});

export type EditToolResult = {
  path: string;
  replacements: number;
  bytesWritten: number;
};

export type EditToolOptions = {
  root?: string;
};

export function createEditTool(
  options: EditToolOptions = {},
): Tool<typeof editParameters, EditToolResult> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "edit",
    description:
      "Atomically edit one existing text file with exact, non-overlapping replacements. Every oldText must match exactly once in the original file.",
    parameters: editParameters,
    outputSchema: Type.Object({
      path: Type.String(),
      replacements: Type.Number(),
      bytesWritten: Type.Number(),
    }),
    execute: async (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Edit aborted.");
      }

      const filePath = await resolveExistingWorkspaceFile(root, args.path);
      const content = await readFile(filePath.absolutePath, "utf8");
      const validationErrors: string[] = [];
      const plannedEdits: Array<{
        index: number;
        start: number;
        end: number;
        newText: string;
      }> = [];

      for (const [index, edit] of args.edits.entries()) {
        const occurrences = countOccurrences(content, edit.oldText);

        if (occurrences === 0) {
          validationErrors.push(`edits[${index}]: text not found`);
          continue;
        }

        if (occurrences > 1) {
          validationErrors.push(
            `edits[${index}]: text appears ${occurrences} times; provide a more specific oldText`,
          );
          continue;
        }

        const start = content.indexOf(edit.oldText);
        plannedEdits.push({
          index,
          start,
          end: start + edit.oldText.length,
          newText: edit.newText,
        });
      }

      const orderedEdits = [...plannedEdits].sort((left, right) => left.start - right.start);

      for (let leftIndex = 0; leftIndex < orderedEdits.length; leftIndex += 1) {
        const left = orderedEdits[leftIndex];
        if (!left) continue;

        for (let rightIndex = leftIndex + 1; rightIndex < orderedEdits.length; rightIndex += 1) {
          const right = orderedEdits[rightIndex];
          if (!right || right.start >= left.end) break;
          validationErrors.push(`edits[${left.index}] and edits[${right.index}]: ranges overlap`);
        }
      }

      if (validationErrors.length > 0) {
        throw new Error(
          [
            `Edit failed for ${args.path}; no changes were written:`,
            ...validationErrors.map((error) => `- ${error}`),
          ].join("\n"),
        );
      }

      // Applying from right to left preserves positions matched against the
      // original content and makes the input array order irrelevant.
      let nextContent = content;
      for (let index = orderedEdits.length - 1; index >= 0; index -= 1) {
        const edit = orderedEdits[index];
        if (!edit) continue;
        nextContent = `${nextContent.slice(0, edit.start)}${edit.newText}${nextContent.slice(edit.end)}`;
      }

      if (context.signal?.aborted) {
        throw new Error("Edit aborted.");
      }

      await writeFile(filePath.absolutePath, nextContent, "utf8");

      const result: EditToolResult = {
        path: filePath.relativePath,
        replacements: plannedEdits.length,
        bytesWritten: Buffer.byteLength(nextContent, "utf8"),
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
    index = nextIndex + 1;
  }
}

function formatEditContent(result: EditToolResult): string {
  return [
    `edited: ${result.path}`,
    `replacements: ${result.replacements}`,
    `bytes: ${result.bytesWritten}`,
  ].join("\n");
}
