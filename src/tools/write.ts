import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./tool";
import { resolveNewWorkspaceFile } from "./workspace-path";

export const writeParameters = Type.Object({
  path: Type.String({
    description: "New file path to create, relative to the workspace root or absolute.",
  }),
  content: Type.String({
    description: "Complete file content to write.",
  }),
});

export type WriteToolResult = {
  path: string;
  bytesWritten: number;
};

export type WriteToolOptions = {
  root?: string;
};

export function createWriteTool(options: WriteToolOptions = {}): Tool<
  typeof writeParameters,
  WriteToolResult
> {
  const root = path.resolve(options.root ?? process.cwd());

  return {
    name: "write",
    description:
      "Create a new text file. Fails if the path already exists; use edit for existing files.",
    parameters: writeParameters,
    execute: async (args, context) => {
      if (context.signal?.aborted) {
        throw new Error("Write aborted.");
      }

      const filePath = await resolveNewWorkspaceFile(root, args.path);
      await mkdir(path.dirname(filePath.absolutePath), { recursive: true });
      await writeFile(filePath.absolutePath, args.content, {
        encoding: "utf8",
        flag: "wx",
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
  return [
    `wrote: ${result.path}`,
    `bytes: ${result.bytesWritten}`,
  ].join("\n");
}
