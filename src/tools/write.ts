import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./tool";

export const writeParameters = Type.Object({
  path: Type.String({
    description: "New file path to create, relative to the workspace root or absolute within it.",
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
      "Create a new text file inside the workspace. Fails if the path already exists; use edit for existing files.",
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

async function resolveNewWorkspaceFile(
  root: string,
  inputPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  if (!inputPath || inputPath.includes("\0")) {
    throw new Error("Invalid file path.");
  }

  const rootPath = await realpath(root);
  const absolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootPath, inputPath);

  if (!isInsideDirectory(rootPath, absolutePath)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }

  if (await pathExists(absolutePath)) {
    throw new Error(`Path already exists: ${inputPath}`);
  }

  const parentPath = await findExistingParent(path.dirname(absolutePath));
  const parentRealPath = await realpath(parentPath);

  if (!isInsideDirectory(rootPath, parentRealPath)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }

  return {
    absolutePath,
    relativePath: path.relative(rootPath, absolutePath) || ".",
  };
}

async function findExistingParent(startPath: string): Promise<string> {
  let currentPath = startPath;

  for (;;) {
    if (await pathExists(currentPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      throw new Error(`No existing parent directory found for: ${startPath}`);
    }

    currentPath = parentPath;
  }
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await lstat(inputPath);

    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return error.code !== "ENOENT";
    }

    throw error;
  }
}

function isInsideDirectory(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function formatWriteContent(result: WriteToolResult): string {
  return [
    `wrote: ${result.path}`,
    `bytes: ${result.bytesWritten}`,
  ].join("\n");
}
