import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempKanaHomes: string[] = [];

export function createTempKanaHomeEnv(): NodeJS.ProcessEnv & { KANA_HOME: string } {
  const kanaHome = mkdtempSync(path.join(tmpdir(), "kana-home-"));
  tempKanaHomes.push(kanaHome);
  return { KANA_HOME: kanaHome };
}

export function cleanupTempKanaHomes(): void {
  for (const kanaHome of tempKanaHomes.splice(0)) {
    rmSync(kanaHome, { recursive: true, force: true });
  }
}
