import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendKanaMemory,
  createKanaSession,
  getKanaMemoryPaths,
  loadKanaMemory,
  saveKanaMemory,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana memory storage", () => {
  test("appends a global daily memory entry with host-owned metadata", () => {
    const env = createTempEnv();
    const now = new Date(2026, 5, 20, 14, 32);

    const entry = appendKanaMemory({
      scope: "global",
      content: "Use Chinese by default.",
      title: "Response language",
      reason: "The user explicitly requested it.",
      env,
      now,
      id: "mem_test",
    });
    const paths = getKanaMemoryPaths("global", { env, now });

    expect(entry).toEqual({
      id: "mem_test",
      createdAt: now.toISOString(),
      scope: "global",
      title: "Response language",
      reason: "The user explicitly requested it.",
      content: "Use Chinese by default.",
    });
    expect(readFileSync(paths.dailyPath, "utf8")).toBe(
      [
        "---",
        'id: "mem_test"',
        `created_at: "${now.toISOString()}"`,
        'scope: "global"',
        'title: "Response language"',
        'reason: "The user explicitly requested it."',
        "---",
        "",
        "Use Chinese by default.",
        "",
        "",
      ].join("\n"),
    );
  });

  test("defaults to project scope and isolates workspaces", () => {
    const env = createTempEnv();
    const workspaceA = path.join(tempDirs[0], "workspace-a");
    const workspaceB = path.join(tempDirs[0], "workspace-b");
    const now = new Date(2026, 5, 20, 14, 32);

    appendKanaMemory({ content: "A-only detail", cwd: workspaceA, env, now, id: "mem_a" });
    appendKanaMemory({ content: "B-only detail", cwd: workspaceB, env, now, id: "mem_b" });

    const projectA = getKanaMemoryPaths("project", { cwd: workspaceA, env, now });
    const projectB = getKanaMemoryPaths("project", { cwd: workspaceB, env, now });

    expect(projectA.dailyPath).not.toBe(projectB.dailyPath);
    expect(readFileSync(projectA.dailyPath, "utf8")).toContain("A-only detail");
    expect(readFileSync(projectB.dailyPath, "utf8")).toContain("B-only detail");
  });

  test("uses the same workspace path encoding as sessions", () => {
    const env = createTempEnv();
    const cwd = path.join(tempDirs[0], "workspace");
    const session = createKanaSession({ cwd, env });
    const memory = getKanaMemoryPaths("project", { cwd, env });

    expect(path.basename(path.dirname(session.path))).toBe(
      path.basename(path.dirname(memory.memoryPath)),
    );
  });

  test("atomically saves and loads consolidated memory", () => {
    const env = createTempEnv();
    const cwd = path.join(tempDirs[0], "workspace");

    expect(loadKanaMemory("project", { cwd, env })).toBe("");

    saveKanaMemory("project", "  # Working context\n\nKeep this.  ", { cwd, env });

    expect(loadKanaMemory("project", { cwd, env })).toBe("# Working context\n\nKeep this.\n");
  });

  test("rejects consolidated memory over the configured character limit", () => {
    const env = createTempEnv();
    writeFileSync(path.join(env.KANA_HOME ?? "", "config.toml"), "[memory]\nmax_chars = 5\n");

    expect(() => saveKanaMemory("global", "💡💡💡💡💡💡", { env })).toThrow(
      "Memory content exceeds memory.max_chars: 6 / 5 characters. Compress it before saving.",
    );
  });

  test("rejects empty memory content", () => {
    expect(() => appendKanaMemory({ content: "  ", env: createTempEnv() })).toThrow(
      "Memory content must not be empty.",
    );
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-memory-"));
  tempDirs.push(home);
  return { KANA_HOME: home };
}
