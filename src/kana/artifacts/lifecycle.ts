import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import type { ContextCheckpoint } from "@/agent";
import type { Message, ToolResultArtifact } from "@/core";
import { encodeKanaWorkspacePath, getKanaConfigPaths } from "../path";
import { getKanaSessionArtifactDirectory, getKanaWorkspaceArtifactDirectory } from "./store";

// A fork copies artifacts before its snapshot is journaled. The grace period
// prevents another Kana process from mistaking that short protocol gap for a
// crash orphan while still giving abandoned files a deterministic cleanup path.
const ORPHAN_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1_000;

export type ForkKanaSessionArtifactsResult = {
  messages: Message[];
  contextCheckpoint?: ContextCheckpoint;
  copiedArtifactCount: number;
};

export type KanaArtifactCleanupResult = {
  removedDirectoryCount: number;
  removedFileCount: number;
  failures: Array<{ errorType: string; errorCode?: string }>;
};

export type KanaArtifactAuditResult = {
  artifactCount: number;
  missingCount: number;
  invalidCount: number;
};

export function auditKanaSessionArtifacts(options: {
  messages: readonly Message[];
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): KanaArtifactAuditResult {
  const directory = path.resolve(
    getKanaSessionArtifactDirectory(options.sessionId, options.cwd, options.env),
  );
  const result: KanaArtifactAuditResult = {
    artifactCount: options.messages.filter(
      (message) => message.role === "tool" && message.artifact !== undefined,
    ).length,
    missingCount: 0,
    invalidCount: 0,
  };
  if (result.artifactCount === 0) {
    return result;
  }

  try {
    assertManagedDirectory(path.dirname(path.dirname(directory)), "artifact root");
    assertManagedDirectory(path.dirname(directory), "workspace artifact path");
    assertManagedDirectory(directory, "session artifact path");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      result.missingCount = result.artifactCount;
    } else {
      result.invalidCount = result.artifactCount;
    }
    return result;
  }

  for (const message of options.messages) {
    if (message.role !== "tool" || !message.artifact) {
      continue;
    }
    const artifact = message.artifact;
    const artifactPath = path.resolve(artifact.locator);
    if (
      artifact.kind !== "text" ||
      path.dirname(artifactPath) !== directory ||
      !message.content.includes(artifact.locator)
    ) {
      result.invalidCount += 1;
      continue;
    }
    try {
      const stats = lstatSync(artifactPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== artifact.byteLength) {
        result.invalidCount += 1;
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        result.missingCount += 1;
      } else {
        result.invalidCount += 1;
      }
    }
  }
  return result;
}

export function forkKanaSessionArtifacts(options: {
  messages: readonly Message[];
  contextCheckpoint?: ContextCheckpoint;
  sourceSessionId: string;
  targetSessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ForkKanaSessionArtifactsResult {
  const messages: Message[] = [...structuredClone(options.messages)];
  const contextCheckpoint =
    options.contextCheckpoint === undefined
      ? undefined
      : structuredClone(options.contextCheckpoint);
  const artifacts = collectArtifactReferences(messages);
  if (artifacts.size === 0) {
    return { messages, contextCheckpoint, copiedArtifactCount: 0 };
  }

  const sourceDirectory = path.resolve(
    getKanaSessionArtifactDirectory(options.sourceSessionId, options.cwd, options.env),
  );
  const targetDirectory = path.resolve(
    getKanaSessionArtifactDirectory(options.targetSessionId, options.cwd, options.env),
  );
  const locatorMap = new Map<string, string>();
  let createdTargetDirectory = false;

  try {
    ensurePrivateDirectorySync(path.dirname(path.dirname(sourceDirectory)));
    ensurePrivateDirectorySync(path.dirname(sourceDirectory));
    ensurePrivateDirectorySync(path.dirname(targetDirectory));
    validateSourceArtifacts(artifacts, sourceDirectory);
    if (existsSync(targetDirectory)) {
      throw new Error("Target session artifact directory already exists.");
    }
    mkdirSync(targetDirectory, { mode: 0o700 });
    createdTargetDirectory = true;

    for (const artifact of artifacts.values()) {
      const targetPath = path.join(targetDirectory, `${randomUUID()}-tool-result.txt`);
      copyFileSync(artifact.locator, targetPath, constants.COPYFILE_EXCL);
      chmodSync(targetPath, 0o600);
      locatorMap.set(artifact.locator, targetPath);
    }

    rewriteArtifactLocators(messages, contextCheckpoint, locatorMap);
    return {
      messages,
      contextCheckpoint,
      copiedArtifactCount: artifacts.size,
    };
  } catch (error) {
    if (createdTargetDirectory) {
      try {
        rmSync(targetDirectory, { recursive: true, force: true });
      } catch {
        // Preserve the copy or rewrite failure that made the fork unusable. A
        // later orphan-cleanup pass owns any rollback residue.
      }
    }
    throw error;
  }
}

export function deleteKanaSessionArtifacts(options: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): KanaArtifactCleanupResult {
  let directory: string;
  try {
    directory = getKanaSessionArtifactDirectory(options.sessionId, options.cwd, options.env);
  } catch (error) {
    return {
      removedDirectoryCount: 0,
      removedFileCount: 0,
      failures: [errorDiagnostic(error)],
    };
  }
  if (!existsSync(directory)) {
    return { removedDirectoryCount: 0, removedFileCount: 0, failures: [] };
  }
  try {
    assertManagedDirectory(path.dirname(path.dirname(directory)), "artifact root");
    assertManagedDirectory(path.dirname(directory), "workspace artifact path");
  } catch (error) {
    return {
      removedDirectoryCount: 0,
      removedFileCount: 0,
      failures: [errorDiagnostic(error)],
    };
  }
  return removeArtifactDirectory(directory);
}

export function cleanupOrphanedKanaSessionArtifacts(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): KanaArtifactCleanupResult {
  const artifactDirectory = getKanaWorkspaceArtifactDirectory(options.cwd, options.env);
  if (!existsSync(artifactDirectory)) {
    return { removedDirectoryCount: 0, removedFileCount: 0, failures: [] };
  }

  const sessionDirectory = path.join(
    getKanaConfigPaths(options.env).sessionsPath,
    encodeKanaWorkspacePath(options.cwd),
  );
  const result: KanaArtifactCleanupResult = {
    removedDirectoryCount: 0,
    removedFileCount: 0,
    failures: [],
  };
  let sessionFilePaths: string[];
  let artifactEntries: Dirent[];

  try {
    const artifactRootStats = lstatSync(path.dirname(artifactDirectory));
    if (!artifactRootStats.isDirectory() || artifactRootStats.isSymbolicLink()) {
      throw new Error("Artifact root is not a managed directory.");
    }
    const artifactStats = lstatSync(artifactDirectory);
    if (!artifactStats.isDirectory() || artifactStats.isSymbolicLink()) {
      throw new Error("Workspace artifact path is not a managed directory.");
    }
    sessionFilePaths = existsSync(sessionDirectory)
      ? readdirSync(sessionDirectory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(sessionDirectory, entry.name))
      : [];
    artifactEntries = readdirSync(artifactDirectory, { withFileTypes: true });
  } catch (error) {
    return {
      removedDirectoryCount: 0,
      removedFileCount: 0,
      failures: [errorDiagnostic(error)],
    };
  }

  const cleanupCutoff = Date.now() - ORPHAN_CLEANUP_GRACE_MS;
  for (const entry of artifactEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const journalPath = sessionFilePaths.find((filePath) =>
      filePath.endsWith(`_${entry.name}.jsonl`),
    );
    const sessionArtifactDirectory = path.join(artifactDirectory, entry.name);
    if (journalPath) {
      cleanupUnreferencedArtifactFiles(
        sessionArtifactDirectory,
        journalPath,
        cleanupCutoff,
        result,
      );
      continue;
    }

    try {
      if (lstatSync(sessionArtifactDirectory).mtimeMs > cleanupCutoff) {
        continue;
      }
    } catch (error) {
      result.failures.push(errorDiagnostic(error));
      continue;
    }

    const removed = removeArtifactDirectory(sessionArtifactDirectory);
    result.removedDirectoryCount += removed.removedDirectoryCount;
    result.removedFileCount += removed.removedFileCount;
    result.failures.push(...removed.failures);
  }
  return result;
}

function collectArtifactReferences(messages: readonly Message[]): Map<string, ToolResultArtifact> {
  const artifacts = new Map<string, ToolResultArtifact>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.artifact) {
      continue;
    }
    if (!message.content.includes(message.artifact.locator)) {
      throw new Error("Tool result artifact notice does not contain its retained locator.");
    }
    artifacts.set(message.artifact.locator, structuredClone(message.artifact));
  }
  return artifacts;
}

function validateSourceArtifacts(
  artifacts: ReadonlyMap<string, ToolResultArtifact>,
  sourceDirectory: string,
): void {
  const directoryStats = lstatSync(sourceDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Source session artifact path is not a private directory.");
  }
  chmodSync(sourceDirectory, 0o700);

  for (const artifact of artifacts.values()) {
    const artifactPath = path.resolve(artifact.locator);
    if (artifact.kind !== "text" || path.dirname(artifactPath) !== sourceDirectory) {
      throw new Error("Fork source contains an artifact from another session scope.");
    }
    const artifactStats = lstatSync(artifactPath);
    if (
      !artifactStats.isFile() ||
      artifactStats.isSymbolicLink() ||
      artifactStats.size !== artifact.byteLength
    ) {
      throw new Error("Fork source artifact is missing, unsafe, or has changed size.");
    }
  }
}

function rewriteArtifactLocators(
  messages: Message[],
  contextCheckpoint: ContextCheckpoint | undefined,
  locatorMap: ReadonlyMap<string, string>,
): void {
  for (const message of messages) {
    if (message.role !== "tool" || !message.artifact) {
      continue;
    }
    const targetLocator = locatorMap.get(message.artifact.locator);
    if (!targetLocator) {
      throw new Error("Forked artifact locator has no copied target.");
    }
    message.content = message.content.replaceAll(message.artifact.locator, targetLocator);
    message.artifact.locator = targetLocator;
  }

  if (contextCheckpoint) {
    for (const [sourceLocator, targetLocator] of locatorMap) {
      contextCheckpoint.summary = contextCheckpoint.summary.replaceAll(
        sourceLocator,
        targetLocator,
      );
    }
  }
}

function ensurePrivateDirectorySync(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Artifact storage path is not a private directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
}

function assertManagedDirectory(directory: string, name: string): void {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${name} is not a managed directory.`);
  }
}

function removeArtifactDirectory(directory: string): KanaArtifactCleanupResult {
  if (!existsSync(directory)) {
    return { removedDirectoryCount: 0, removedFileCount: 0, failures: [] };
  }
  try {
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Artifact cleanup target is not a managed directory.");
    }
    rmSync(directory, { recursive: true, force: true });
    return { removedDirectoryCount: 1, removedFileCount: 0, failures: [] };
  } catch (error) {
    return {
      removedDirectoryCount: 0,
      removedFileCount: 0,
      failures: [errorDiagnostic(error)],
    };
  }
}

function cleanupUnreferencedArtifactFiles(
  directory: string,
  journalPath: string,
  cleanupCutoff: number,
  result: KanaArtifactCleanupResult,
): void {
  try {
    const directoryStats = lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Session artifact path is not a managed directory.");
    }
    const journal = readFileSync(journalPath, "utf8");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const artifactPath = path.join(directory, entry.name);
      const artifactStats = lstatSync(artifactPath);
      // Locators are JSON string fields in the append-only journal. Searching
      // for the encoded string is conservative and avoids repairing or fully
      // parsing a possibly interrupted journal during best-effort cleanup.
      if (
        artifactStats.isSymbolicLink() ||
        artifactStats.mtimeMs > cleanupCutoff ||
        journal.includes(JSON.stringify(artifactPath))
      ) {
        continue;
      }
      rmSync(artifactPath, { force: true });
      result.removedFileCount += 1;
    }
  } catch (error) {
    result.failures.push(errorDiagnostic(error));
  }
}

function errorDiagnostic(error: unknown): { errorType: string; errorCode?: string } {
  const errorCode = getErrorCode(error);
  return {
    errorType: getErrorType(error),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function getErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
