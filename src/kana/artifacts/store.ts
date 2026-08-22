import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ToolResultArtifact } from "@/core";
import { getKanaConfigPaths } from "../config";
import { encodeKanaWorkspacePath } from "../path";

const MAX_SUGGESTED_STEM_LENGTH = 48;

export type KanaSessionArtifactStore = {
  readonly persistent: boolean;
  saveText(content: string, suggestedName: string): Promise<ToolResultArtifact>;
  discard(artifact: ToolResultArtifact): Promise<void>;
  close(): Promise<void>;
};

type CreateStoreOptions = {
  directory: string;
  privateDirectories: readonly string[];
  persistent: boolean;
};

export function createPersistentKanaSessionArtifactStore(options: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): KanaSessionArtifactStore {
  const directory = getKanaSessionArtifactDirectory(options.sessionId, options.cwd, options.env);
  const workspaceDirectory = path.dirname(directory);
  return createStore({
    directory,
    privateDirectories: [path.dirname(workspaceDirectory), workspaceDirectory, directory],
    persistent: true,
  });
}

export function createTemporaryKanaSessionArtifactStore(): KanaSessionArtifactStore {
  const directory = path.join(tmpdir(), `kana-session-artifacts-${randomUUID()}`);
  return createStore({
    directory,
    privateDirectories: [directory],
    persistent: false,
  });
}

export function getKanaWorkspaceArtifactDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getKanaConfigPaths(env).artifactsPath, encodeKanaWorkspacePath(cwd));
}

export function getKanaSessionArtifactDirectory(
  sessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertSafeSessionId(sessionId);
  return path.join(getKanaWorkspaceArtifactDirectory(cwd, env), sessionId);
}

function createStore(options: CreateStoreOptions): KanaSessionArtifactStore {
  const directory = path.resolve(options.directory);
  const privateDirectories = options.privateDirectories.map((item) => path.resolve(item));

  return {
    persistent: options.persistent,
    async saveText(content, suggestedName) {
      for (const privateDirectory of privateDirectories) {
        await ensurePrivateDirectory(privateDirectory);
      }

      const fileName = `${randomUUID()}-${sanitizeSuggestedStem(suggestedName)}.txt`;
      const filePath = path.join(directory, fileName);
      let handle: Awaited<ReturnType<typeof open>> | undefined;

      try {
        // O_NOFOLLOW and an unpredictable name make the exclusive create safe
        // even if another local process can observe the parent directory.
        handle = await open(
          filePath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(content, { encoding: "utf8" });
        await handle.sync();
        await handle.close();
        handle = undefined;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(filePath, { force: true }).catch(() => undefined);
        throw error;
      }

      return {
        kind: "text",
        locator: filePath,
        byteLength: Buffer.byteLength(content, "utf8"),
      };
    },
    async discard(artifact) {
      const artifactPath = resolveOwnedArtifactPath(directory, artifact);
      await rm(artifactPath, { force: true });
    },
    async close() {
      if (!options.persistent) {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Artifact storage path is not a private directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

function resolveOwnedArtifactPath(directory: string, artifact: ToolResultArtifact): string {
  const artifactPath = path.resolve(artifact.locator);
  if (artifact.kind !== "text" || path.dirname(artifactPath) !== directory) {
    throw new Error("Artifact locator does not belong to this session store.");
  }
  return artifactPath;
}

function sanitizeSuggestedStem(value: string): string {
  const baseName = path.basename(value, path.extname(value));
  const normalized = baseName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SUGGESTED_STEM_LENGTH);
  return normalized || "tool-result";
}

function assertSafeSessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sessionId)
  ) {
    throw new Error("sessionId must be a non-empty file-name-safe string.");
  }
}
