import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function createSessionFixture() {
  const tempDirs: string[] = [];

  function createTempEnv(): NodeJS.ProcessEnv {
    const home = mkdtempSync(path.join(tmpdir(), "kana-session-"));
    tempDirs.push(home);
    const kanaHome = path.join(home, ".kana");
    mkdirSync(kanaHome, { recursive: true });

    return { HOME: home, KANA_HOME: kanaHome };
  }

  function cleanupTempDirs(): void {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { cleanupTempDirs, createTempEnv };
}
