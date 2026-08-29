import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

export function cleanupConfigTempDirs(): void {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function createTempEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = createTempDir();
  mkdirSync(path.join(home, ".kana"), { recursive: true });

  return {
    HOME: home,
    ...extra,
  };
}

export function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kana-config-"));
  tempDirs.push(dir);
  return dir;
}
