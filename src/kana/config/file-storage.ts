import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function withLockedConfigFile<T>(filePath: string, update: () => T): T {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const release = acquireConfigFileLock(filePath);
  try {
    return update();
  } finally {
    release();
  }
}

export function readOptionalConfigFile(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
}

export function writeConfigFileAtomically(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function mergeConfigStringSet(
  persisted: readonly string[],
  previousSnapshot: readonly string[],
  nextSnapshot: readonly string[],
): string[] {
  const previous = new Set(previousSnapshot);
  const next = new Set(nextSnapshot);
  const removed = new Set(previousSnapshot.filter((value) => !next.has(value)));
  const merged = persisted.filter((value) => !removed.has(value));
  const mergedSet = new Set(merged);

  for (const value of nextSnapshot) {
    if (!previous.has(value) && !mergedSet.has(value)) {
      merged.push(value);
      mergedSet.add(value);
    }
  }

  return merged;
}

function acquireConfigFileLock(filePath: string): () => void {
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt += 1) {
    try {
      return lockfile.lockSync(filePath, { realpath: false });
    } catch (error) {
      if (!isLockedError(error) || attempt === LOCK_ATTEMPTS) {
        throw error;
      }
      Atomics.wait(LOCK_RETRY_SIGNAL, 0, 0, LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Could not lock configuration file ${filePath}.`);
}

function isLockedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ELOCKED"
  );
}
