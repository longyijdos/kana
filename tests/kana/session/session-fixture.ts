import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function createSessionFixture() {
  const tempDirs: string[] = [];

  function createTempEnv(): NodeJS.ProcessEnv {
    const home = mkdtempSync(path.join(tmpdir(), "kana-session-"));
    tempDirs.push(home);
    mkdirSync(path.join(home, ".kana"), { recursive: true });

    return { HOME: home };
  }

  function cleanupTempDirs(): void {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { cleanupTempDirs, createTempEnv };
}
