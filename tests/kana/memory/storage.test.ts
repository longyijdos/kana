import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
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
import {
  createMemoryConsolidationTransaction,
  readPendingKanaMemoryBatch,
} from "../../../src/kana/memory";
import {
  cleanupTempKanaHomes,
  createTempKanaHomeEnv as createTempEnv,
} from "../../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

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
    const workspaceA = path.join(env.KANA_HOME, "workspace-a");
    const workspaceB = path.join(env.KANA_HOME, "workspace-b");
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
    const cwd = path.join(env.KANA_HOME, "workspace");
    const session = createKanaSession({ cwd, env });
    const memory = getKanaMemoryPaths("project", { cwd, env });

    expect(path.basename(path.dirname(session.path))).toBe(
      path.basename(path.dirname(memory.memoryPath)),
    );
  });

  test("atomically saves and loads consolidated memory", () => {
    const env = createTempEnv();
    const cwd = path.join(env.KANA_HOME, "workspace");

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

  test("prunes only dates fully processed and outside the retention window", () => {
    const env = createTempEnv();
    const expired = new Date(2026, 5, 17);
    appendKanaMemory({ scope: "global", content: "Prunable", env, now: new Date(2026, 5, 16) });
    appendKanaMemory({ scope: "global", content: "Expired", env, now: expired });
    const batch = readPendingKanaMemoryBatch("global", { env })!;
    const full = createMemoryConsolidationTransaction({ scope: "global", env });
    full.commit(batch.checkpoint);
    appendKanaMemory({ scope: "global", content: "Still pending", env, now: expired });
    appendKanaMemory({
      scope: "global",
      content: "Expired and pending",
      env,
      now: new Date(2026, 5, 18),
    });
    appendKanaMemory({ scope: "global", content: "Today", env, now: new Date(2026, 5, 20) });
    full.replace("Full Compact only updates the body.");
    full.commit();

    expect(
      pruneKanaDailyMemory("global", {
        env,
        retentionDays: 2,
        now: new Date(2026, 5, 20),
      }),
    ).toEqual(["2026-06-16"]);
    expect(listKanaDailyMemory("global", { env })).toEqual([
      { date: "2026-06-17", entryCount: 2 },
      { date: "2026-06-18", entryCount: 1 },
      { date: "2026-06-20", entryCount: 1 },
    ]);
    expect(
      readPendingKanaMemoryBatch("global", { env })?.entries.map(({ content }) => content),
    ).toEqual(["Still pending", "Expired and pending", "Today"]);
  });

  test("keeps only the latest cursor while replaying multi-line entries across dates", () => {
    const env = createTempEnv();
    const oldDay = new Date(2026, 5, 20);
    const newDay = new Date(2026, 5, 21);
    const content = "Use Bun.\n\n---\n\n- Keep the lockfile.\n- Run checks.";
    const old = appendKanaMemory({ scope: "global", content, env, now: oldDay });
    const batch = readPendingKanaMemoryBatch("global", { env })!;
    expect(batch.entries).toEqual([old]);
    const memory = createMemoryConsolidationTransaction({ scope: "global", env });
    memory.commit(batch.checkpoint);
    const sameDay = appendKanaMemory({ scope: "global", content, env, now: oldDay });
    const nextDay = appendKanaMemory({
      scope: "global",
      content,
      env,
      now: newDay,
      id: "mem_next",
    });
    expect(readKanaDailyMemory("global", "2026-06-20", { env })).toEqual([old, sameDay]);
    const pending = readPendingKanaMemoryBatch("global", { env })!;
    expect(pending.entries).toEqual([sameDay, nextDay]);
    memory.commit(pending.checkpoint);
    const { memoryPath } = getKanaMemoryPaths("global", { env });
    expect(readFileSync(memoryPath, "utf8")).toBe(
      '<!-- kana-memory-checkpoint: ["2026-06-21","mem_next"] -->\n\n',
    );

    expect(
      pruneKanaDailyMemory("global", { env, retentionDays: 1, now: new Date(2026, 5, 22) }),
    ).toEqual(["2026-06-20", "2026-06-21"]);
    const later = appendKanaMemory({ scope: "global", content, env, now: new Date(2026, 5, 22) });
    expect(readPendingKanaMemoryBatch("global", { env })?.entries).toEqual([later]);
  });

  test("commits the checkpoint and body together; a failed replacement leaves the batch pending", () => {
    const env = createTempEnv();
    const entry = appendKanaMemory({ scope: "global", content: "New fact", env });
    const batch = readPendingKanaMemoryBatch("global", { env })!;
    const transaction = createMemoryConsolidationTransaction({ scope: "global", env });
    transaction.replace(entry.content);
    const { memoryPath } = getKanaMemoryPaths("global", { env });
    mkdirSync(memoryPath);
    expect(() => transaction.commit(batch.checkpoint)).toThrow();
    rmdirSync(memoryPath);
    expect(loadKanaMemory("global", { env })).toBe("");
    expect(readPendingKanaMemoryBatch("global", { env })?.entries).toEqual([entry]);

    transaction.commit(batch.checkpoint);
    expect(readFileSync(memoryPath, "utf8")).toContain(entry.id);
    expect(loadKanaMemory("global", { env })).toBe("New fact\n");
    expect(readPendingKanaMemoryBatch("global", { env })).toBeUndefined();
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
