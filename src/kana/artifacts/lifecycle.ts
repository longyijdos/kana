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
import { errorCode, errorFields } from "@/utils";
import { encodeKanaWorkspacePath, getKanaConfigPaths } from "../path";
import {
  getKanaSessionArtifactDirectory,
  getKanaSubagentArtifactParentDirectory,
  getKanaWorkspaceArtifactDirectory,
} from "./store";

// A fork copies artifacts before its snapshot is journaled. The grace period
// prevents another Kana process from mistaking that short protocol gap for a
// crash orphan while still giving abandoned files a deterministic cleanup path.
const ORPHAN_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1_000;

export type ForkKanaSessionArtifactsResult = {
  messages: readonly Message[];
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
    if (errorCode(error) === "ENOENT") {
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
      if (errorCode(error) === "ENOENT") {
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
  const { messages, contextCheckpoint } = options;
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

    return {
      ...rewriteArtifactLocators(messages, contextCheckpoint, locatorMap),
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
  const result: KanaArtifactCleanupResult = {
    removedDirectoryCount: 0,
    removedFileCount: 0,
    failures: [],
  };
  try {
    const directory = getKanaSessionArtifactDirectory(options.sessionId, options.cwd, options.env);
    const subagentDirectory = getKanaSubagentArtifactParentDirectory(
      options.sessionId,
      options.cwd,
      options.env,
    );
    if (!existsSync(directory) && !existsSync(subagentDirectory)) {
      return result;
    }
    assertManagedDirectory(path.dirname(path.dirname(directory)), "artifact root");
    assertManagedDirectory(path.dirname(directory), "workspace artifact path");
    for (const target of [directory, subagentDirectory]) {
      try {
        if (target === subagentDirectory && existsSync(target)) {
          assertManagedDirectory(path.dirname(target), "subagent artifact root");
        }
        const removed = removeArtifactDirectory(target);
        result.removedDirectoryCount += removed.removedDirectoryCount;
        result.failures.push(...removed.failures);
      } catch (error) {
        result.failures.push(errorFields(error));
      }
    }
  } catch (error) {
    result.failures.push(errorFields(error));
  }
  return result;
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
    sessionFilePaths = listJournalPaths(sessionDirectory);
    artifactEntries = readdirSync(artifactDirectory, { withFileTypes: true });
  } catch (error) {
    return {
      removedDirectoryCount: 0,
      removedFileCount: 0,
      failures: [errorFields(error)],
    };
  }

  const cleanupCutoff = Date.now() - ORPHAN_CLEANUP_GRACE_MS;
  for (const entry of artifactEntries) {
    if (!entry.isDirectory() || entry.name === ".subagents") {
      continue;
    }
    cleanupArtifactDirectory(
      path.join(artifactDirectory, entry.name),
      findJournalPath(sessionFilePaths, entry.name),
      cleanupCutoff,
      result,
    );
  }
  cleanupSubagentArtifacts(
    artifactDirectory,
    sessionDirectory,
    sessionFilePaths,
    cleanupCutoff,
    result,
  );
  return result;
}

function listJournalPaths(directory: string): string[] {
  if (!existsSync(directory)) return [];
  assertManagedDirectory(directory, "session journal path");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(directory, entry.name));
}

function findJournalPath(journals: readonly string[], sessionId: string): string | undefined {
  return journals.find((filePath) => filePath.endsWith(`_${sessionId}.jsonl`));
}

function cleanupSubagentArtifacts(
  artifactDirectory: string,
  sessionDirectory: string,
  parentJournals: readonly string[],
  cleanupCutoff: number,
  result: KanaArtifactCleanupResult,
): void {
  const subagentDirectory = path.join(artifactDirectory, ".subagents");
  if (!existsSync(subagentDirectory)) return;
  try {
    assertManagedDirectory(subagentDirectory, "subagent artifact root");
    for (const parent of readdirSync(subagentDirectory, { withFileTypes: true })) {
      if (!parent.isDirectory()) continue;
      const parentDirectory = path.join(subagentDirectory, parent.name);
      if (!findJournalPath(parentJournals, parent.name)) {
        cleanupArtifactDirectory(parentDirectory, undefined, cleanupCutoff, result);
        continue;
      }
      try {
        const journalRoot = path.join(sessionDirectory, ".subagents");
        if (existsSync(journalRoot)) assertManagedDirectory(journalRoot, "subagent journal root");
        const journals = listJournalPaths(path.join(journalRoot, parent.name));
        for (const child of readdirSync(parentDirectory, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          cleanupArtifactDirectory(
            path.join(parentDirectory, child.name),
            findJournalPath(journals, child.name),
            cleanupCutoff,
            result,
          );
        }
      } catch (error) {
        result.failures.push(errorFields(error));
      }
    }
  } catch (error) {
    result.failures.push(errorFields(error));
  }
}

function cleanupArtifactDirectory(
  directory: string,
  journalPath: string | undefined,
  cleanupCutoff: number,
  result: KanaArtifactCleanupResult,
): void {
  if (journalPath) {
    cleanupUnreferencedArtifactFiles(directory, journalPath, cleanupCutoff, result);
    return;
  }
  try {
    if (lstatSync(directory).mtimeMs > cleanupCutoff) return;
    const removed = removeArtifactDirectory(directory);
    result.removedDirectoryCount += removed.removedDirectoryCount;
    result.removedFileCount += removed.removedFileCount;
    result.failures.push(...removed.failures);
  } catch (error) {
    result.failures.push(errorFields(error));
  }
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
    artifacts.set(message.artifact.locator, message.artifact);
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
  messages: readonly Message[],
  contextCheckpoint: ContextCheckpoint | undefined,
  locatorMap: ReadonlyMap<string, string>,
): Pick<ForkKanaSessionArtifactsResult, "messages" | "contextCheckpoint"> {
  const rewritten = messages.map((message) => {
    if (message.role !== "tool" || !message.artifact) {
      return message;
    }
    const sourceLocator = message.artifact.locator;
    const targetLocator = locatorMap.get(sourceLocator);
    if (!targetLocator) {
      throw new Error("Forked artifact locator has no copied target.");
    }
    return {
      ...message,
      content: message.content.replaceAll(sourceLocator, targetLocator),
      artifact: { ...message.artifact, locator: targetLocator },
    };
  });
  if (!contextCheckpoint) {
    return { messages: rewritten, contextCheckpoint };
  }
  let summary = contextCheckpoint.summary;
  for (const [sourceLocator, targetLocator] of locatorMap) {
    summary = summary.replaceAll(sourceLocator, targetLocator);
  }
  return { messages: rewritten, contextCheckpoint: { ...contextCheckpoint, summary } };
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
      failures: [errorFields(error)],
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
    result.failures.push(errorFields(error));
  }
}
