import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { strictObject } from "./strict-object";
import type { Tool } from "./tool";
import { resolveNewWorkspaceFile } from "./workspace-path";

export const writeParameters = strictObject({
  path: Type.String({
    description: "New file path to create, relative to the workspace root or absolute.",
  }),
  content: Type.String({
    description: "Complete file content to write.",
  }),
  overwrite: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Overwrite the target file if it already exists. Defaults to false, which creates only new files.",
    }),
  ),
});

export type WriteToolResult = {
  path: string;
  bytesWritten: number;
};

export type WriteToolOptions = {
  root?: string;
};

export function createWriteTool(
  options: WriteToolOptions = {},
): Tool<typeof writeParameters, WriteToolResult> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "write",
    description:
      "Write a complete text file. Creates new files by default; set overwrite to true to replace an existing file.",
    parameters: writeParameters,
    execute: async (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Write aborted.");
      }

      const overwrite = args.overwrite ?? false;
      const filePath = await resolveNewWorkspaceFile(root, args.path, { overwrite });
      await mkdir(path.dirname(filePath.absolutePath), { recursive: true });
      await writeFile(filePath.absolutePath, args.content, {
        encoding: "utf8",
        flag: overwrite ? "w" : "wx",
      });

      const result: WriteToolResult = {
        path: filePath.relativePath,
        bytesWritten: Buffer.byteLength(args.content, "utf8"),
      };

      return {
        content: formatWriteContent(result),
        result,
      };
    },
  };
}

function formatWriteContent(result: WriteToolResult): string {
  return [`wrote: ${result.path}`, `bytes: ${result.bytesWritten}`].join("\n");
}
