import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type WorkspacePath = {
  absolutePath: string;
  relativePath: string;
};

export async function resolveExistingWorkspaceFile(
  root: string,
  inputPath: string,
): Promise<WorkspacePath> {
  if (!isValidInputPath(inputPath)) {
    throw new Error("Invalid file path.");
  }

  const rootPath = await realpath(root);
  const requestedPath = resolveInputPath(rootPath, inputPath);
  const absolutePath = await realpath(requestedPath);
  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${inputPath}`);
  }

  return workspacePath(rootPath, absolutePath);
}

export async function resolveNewWorkspaceFile(
  root: string,
  inputPath: string,
): Promise<WorkspacePath> {
  if (!isValidInputPath(inputPath)) {
    throw new Error("Invalid file path.");
  }

  const rootPath = await realpath(root);
  const absolutePath = resolveInputPath(rootPath, inputPath);

  if (await pathExists(absolutePath)) {
    throw new Error(`Path already exists: ${inputPath}`);
  }

  return {
    absolutePath,
    relativePath: relativeWorkspacePath(rootPath, await canonicalizeNewPath(absolutePath)),
  };
}

export async function resolveWorkspaceDirectory(
  root: string,
  inputPath: string,
): Promise<WorkspacePath> {
  if (!isValidInputPath(inputPath)) {
    throw new Error("Invalid working directory.");
  }

  const rootPath = await realpath(root);
  const requestedPath = resolveInputPath(rootPath, inputPath);

  return workspacePath(rootPath, await realpath(requestedPath));
}

function isValidInputPath(inputPath: string): boolean {
  return Boolean(inputPath) && !inputPath.includes("\0");
}

function resolveInputPath(rootPath: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(rootPath, inputPath);
}

async function canonicalizeNewPath(absolutePath: string): Promise<string> {
  const parentPath = await findExistingParent(path.dirname(absolutePath));
  const parentRealPath = await realpath(parentPath);
  const relativePath = path.relative(parentPath, absolutePath);

  return path.join(parentRealPath, relativePath);
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

function workspacePath(rootPath: string, absolutePath: string): WorkspacePath {
  return {
    absolutePath,
    relativePath: relativeWorkspacePath(rootPath, absolutePath),
  };
}

function relativeWorkspacePath(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath) || ".";
}
