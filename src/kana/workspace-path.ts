import path from "node:path";

// Workspace-scoped Kana data must use one stable encoding so sessions and
// project memory resolve to the same logical workspace directory name.
export function encodeKanaWorkspacePath(cwd: string): string {
  return `--${path
    .resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`;
}
