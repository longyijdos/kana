import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendKanaMemory,
  createKanaSession,
  getKanaMemoryPaths,
  listKanaDailyMemory,
  loadKanaMemory,
  pruneKanaDailyMemory,
  readKanaDailyMemory,
  saveKanaMemory,
  searchKanaDailyMemory,
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

  test("lists, reads, and searches daily memory by date without paths", () => {
    const env = createTempEnv();
    const firstDay = new Date(2026, 5, 19, 9, 0);
    const secondDay = new Date(2026, 5, 20, 9, 0);
    appendKanaMemory({ scope: "global", content: "Use Chinese.", env, now: firstDay });
    appendKanaMemory({
      scope: "global",
      content: "Sessions append after each run.",
      env,
      now: secondDay,
    });
    appendKanaMemory({
      scope: "global",
      content: "Run tests before committing.",
      env,
      now: secondDay,
    });

    expect(listKanaDailyMemory("global", { env })).toEqual([
      { date: "2026-06-19", entryCount: 1 },
      { date: "2026-06-20", entryCount: 2 },
    ]);
    expect(
      readKanaDailyMemory("global", "2026-06-20", { env }).map((entry) => entry.content),
    ).toEqual(["Sessions append after each run.", "Run tests before committing."]);
    expect(searchKanaDailyMemory("global", "session", { env })).toEqual([
      {
        date: "2026-06-20",
        entryCount: 2,
        matchCount: 1,
        snippets: ["Sessions append after each run."],
      },
    ]);
  });

  test("prunes daily memory outside the retention window", () => {
    const env = createTempEnv();
    appendKanaMemory({ scope: "global", content: "Expired", env, now: new Date(2026, 5, 17) });
    appendKanaMemory({ scope: "global", content: "Retained", env, now: new Date(2026, 5, 18) });
    appendKanaMemory({ scope: "global", content: "Today", env, now: new Date(2026, 5, 20) });

    expect(
      pruneKanaDailyMemory("global", {
        env,
        retentionDays: 3,
        now: new Date(2026, 5, 20),
      }),
    ).toEqual(["2026-06-17"]);
    expect(listKanaDailyMemory("global", { env })).toEqual([
      { date: "2026-06-18", entryCount: 1 },
      { date: "2026-06-20", entryCount: 1 },
    ]);
  });

  test("rejects empty memory content", () => {
    expect(() => appendKanaMemory({ content: "  ", env: createTempEnv() })).toThrow(
      "Memory content must not be empty.",
    );
  });

  test("rejects invalid daily memory dates", () => {
    expect(() => readKanaDailyMemory("global", "2026-02-31", { env: createTempEnv() })).toThrow(
      "date must be a valid YYYY-MM-DD date.",
    );
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-memory-"));
  tempDirs.push(home);
  return { KANA_HOME: home };
}
