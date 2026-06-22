import path from "node:path";

import { getKanaConfigPaths } from "./config";

// Workspace-scoped Kana data must use one stable encoding so sessions,
// project memory, and runtime logs resolve to the same logical directory name.
export function encodeKanaWorkspacePath(cwd: string): string {
  return `--${path
    .resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
}

export type KanaLogPathOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function getKanaSessionLogPath(sessionId: string, options: KanaLogPathOptions = {}): string {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error("sessionId must be a non-empty file-name-safe string.");
  }

  return path.join(
    getKanaConfigPaths(options.env).logsPath,
    encodeKanaWorkspacePath(options.cwd ?? process.cwd()),
    `${sessionId}.jsonl`,
  );
}
