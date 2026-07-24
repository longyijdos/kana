import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextCheckpoint } from "@/agent";
import type { Message } from "@/core";
import {
  appendKanaSessionMessages,
  appendKanaSessionRun,
  createKanaSession,
  deleteKanaSession,
  getKanaConfigPaths,
  listKanaSessions,
  loadKanaSession,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana session store", () => {
  test("creates session metadata without writing a JSONL file", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "empty-session" });

    expect(existsSync(session.path)).toBe(false);
    expect(listKanaSessions({ env, cwd })).toEqual([]);
  });

  test("creates JSONL sessions on first append and reloads messages by id", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({
      cwd,
      env,
      id: "session-1",
      model: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    });
    const messages: Message[] = [
      {
        role: "user",
        content: "hi",
      },
      {
        role: "assistant",
        stopReason: "stop",
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          promptCacheHitTokens: 90,
          promptCacheMissTokens: 10,
          reasoningTokens: 5,
        },
        content: [
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    ];

    appendKanaSessionMessages(session, messages, {
      timestamp: "2026-06-12T00:00:00.000Z",
    });

    const loaded = loadKanaSession("session-1", { env, cwd });
    const lines = readFileSync(session.path, "utf8").trim().split("\n");
    const firstEntry = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    const secondEntry = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;

    expect(loaded.metadata).toEqual(session);
    expect(loaded.messages).toEqual(messages);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "session",
      version: 2,
      id: "session-1",
      title: "hi",
      cwd,
      model: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    });
    expect(session.title).toBe("hi");
    expect(firstEntry).toMatchObject({
      type: "message",
      parentId: null,
      timestamp: "2026-06-12T00:00:00.000Z",
      message: {
        role: "user",
      },
    });
    expect(secondEntry).toMatchObject({
      type: "message",
      parentId: firstEntry.id,
      timestamp: "2026-06-12T00:00:00.000Z",
      message: {
        role: "assistant",
        usage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          promptCacheHitTokens: 90,
          promptCacheMissTokens: 10,
          reasoningTokens: 5,
        },
      },
    });
    expect(loaded.timeline).toHaveLength(2);
    expect(loaded.contextCheckpoint).toBeUndefined();
  });

  test("persists manual compaction checkpoints without deleting covered messages", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "compacted" });
    const messages: Message[] = [
      { role: "user", content: "Old question" },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Old answer" }],
      },
      { role: "user", content: "Recent question" },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Recent answer" }],
      },
    ];
    const checkpoint: ContextCheckpoint = {
      id: "compact-1",
      summary: "The old exchange is complete.",
      coveredMessageCount: 2,
      createdAfterMessageCount: 4,
      compactedMessageCount: 2,
      reason: "manual",
      beforeTokens: 90_000,
      estimatedAfterTokens: 60_000,
      usage: {
        promptTokens: 2_000,
        completionTokens: 100,
        totalTokens: 2_100,
      },
      createdAt: "2026-07-24T00:00:01.000Z",
    };

    appendKanaSessionRun(session, messages, {
      timestamp: "2026-07-24T00:00:00.000Z",
      compactions: [checkpoint],
    });

    const loaded = loadKanaSession("compacted", { env, cwd });
    const compaction = loaded.timeline.at(-1);

    expect(loaded.messages).toEqual(messages);
    expect(loaded.timeline).toHaveLength(5);
    expect(compaction).toMatchObject({
      type: "context_compaction",
      id: "compact-1",
      parentId: expect.any(String),
      reason: "manual",
      compactedMessageCount: 2,
      beforeTokens: 90_000,
      estimatedAfterTokens: 60_000,
      summary: {
        format: "kana-context-summary-v1",
        text: "The old exchange is complete.",
      },
    });
    expect(compaction).toHaveProperty("coversThroughId", loaded.timeline[1]?.id);
    expect(loaded.contextCheckpoint).toEqual(checkpoint);
  });

  test("links cumulative checkpoints and resumes from the latest summary", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "checkpoint-chain" });
    const firstMessages: Message[] = [
      { role: "user", content: "First question" },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "First answer" }],
      },
      { role: "user", content: "Second question" },
    ];
    const firstCheckpoint: ContextCheckpoint = {
      id: "compact-1",
      summary: "First exchange.",
      coveredMessageCount: 2,
      createdAfterMessageCount: 3,
      compactedMessageCount: 2,
      reason: "threshold",
      beforeTokens: 90_000,
      estimatedAfterTokens: 60_000,
      createdAt: "2026-07-24T00:00:01.000Z",
    };
    appendKanaSessionRun(session, firstMessages, {
      compactions: [firstCheckpoint],
    });

    const secondMessages: Message[] = [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Second answer" }],
      },
      { role: "user", content: "Third question" },
    ];
    const secondCheckpoint: ContextCheckpoint = {
      id: "compact-2",
      baseCompactionId: "compact-1",
      summary: "First and second exchanges.",
      coveredMessageCount: 4,
      createdAfterMessageCount: 5,
      compactedMessageCount: 2,
      reason: "provider_limit",
      beforeTokens: 95_000,
      estimatedAfterTokens: 58_000,
      createdAt: "2026-07-24T00:00:02.000Z",
    };
    appendKanaSessionRun(session, secondMessages, {
      compactions: [secondCheckpoint],
    });

    const loaded = loadKanaSession("checkpoint-chain", { env, cwd });

    expect(loaded.messages).toEqual([...firstMessages, ...secondMessages]);
    expect(
      loaded.timeline
        .filter((entry) => entry.type === "context_compaction")
        .map((entry) => entry.id),
    ).toEqual(["compact-1", "compact-2"]);
    expect(loaded.contextCheckpoint).toEqual(secondCheckpoint);
  });

  test("atomically upgrades a v1 session before its first compaction entry", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "legacy" });
    mkdirSync(path.dirname(session.path), { recursive: true });
    const header = {
      type: "session",
      version: 1,
      id: session.id,
      createdAt: session.createdAt,
      title: "Legacy",
      cwd,
    };
    const userEntry = {
      type: "message",
      id: "message-1",
      parentId: null,
      timestamp: "2026-07-24T00:00:00.000Z",
      message: { role: "user", content: "Legacy question" },
    };
    const assistantEntry = {
      type: "message",
      id: "message-2",
      parentId: "message-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Legacy answer" }],
      },
    };
    writeFileSync(
      session.path,
      `${[header, userEntry, assistantEntry].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      {
        mode: 0o600,
      },
    );
    const checkpoint: ContextCheckpoint = {
      id: "compact-legacy",
      summary: "Legacy exchange.",
      coveredMessageCount: 2,
      createdAfterMessageCount: 2,
      compactedMessageCount: 2,
      reason: "threshold",
      beforeTokens: 90_000,
      estimatedAfterTokens: 60_000,
      createdAt: "2026-07-24T00:00:01.000Z",
    };

    appendKanaSessionRun(session, [], {
      compactions: [checkpoint],
    });

    const lines = readFileSync(session.path, "utf8").trim().split("\n");

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "session",
      version: 2,
      id: "legacy",
    });
    expect(JSON.parse(lines[1] ?? "{}")).toEqual(userEntry);
    expect(JSON.parse(lines[2] ?? "{}")).toEqual(assistantEntry);
    expect(JSON.parse(lines[3] ?? "{}")).toMatchObject({
      type: "context_compaction",
      id: "compact-legacy",
      coversThroughId: "message-2",
    });
    expect(loadKanaSession("legacy", { env, cwd }).contextCheckpoint).toEqual(checkpoint);
  });

  test("lists sessions from the configured Kana home", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const first = createKanaSession({ cwd, env, id: "first" });
    const second = createKanaSession({ cwd, env, id: "second" });

    appendKanaSessionMessages(first, [{ role: "user", content: "first" }]);
    appendKanaSessionMessages(second, [{ role: "user", content: "second" }]);

    expect(new Set(listKanaSessions({ env, cwd }).map((session) => session.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(new Set(listKanaSessions({ env }).map((session) => session.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(getKanaConfigPaths(env).sessionsPath).toContain(".kana/sessions");
  });

  test("records parent session paths when a session is first appended", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const messages: Message[] = [
      {
        role: "user",
        content: "branch from here",
      },
    ];
    const fork = createKanaSession({
      cwd,
      env,
      id: "fork",
      parentSessionPath: "/tmp/source.jsonl",
    });

    appendKanaSessionMessages(fork, messages);

    const loaded = loadKanaSession("fork", { env, cwd });
    const header = JSON.parse(readFileSync(fork.path, "utf8").split("\n")[0] ?? "{}") as Record<
      string,
      unknown
    >;

    expect(fork.parentSessionPath).toBe("/tmp/source.jsonl");
    expect(loaded.messages).toEqual(messages);
    expect(header).toMatchObject({
      type: "session",
      id: "fork",
      title: "branch from here",
      parentSessionPath: "/tmp/source.jsonl",
    });
  });

  test("uses an explicit session title when provided", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({
      cwd,
      env,
      id: "titled",
      title: "Compare parser approaches",
    });

    appendKanaSessionMessages(session, [
      {
        role: "user",
        content: "this prompt should not replace the explicit title",
      },
    ]);

    const loaded = loadKanaSession("titled", { env, cwd });

    expect(loaded.metadata.title).toBe("Compare parser approaches");
  });

  test("deletes sessions by id", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "delete-me" });

    appendKanaSessionMessages(session, [{ role: "user", content: "remove this" }]);

    expect(deleteKanaSession("missing", { env, cwd })).toBe(false);
    expect(deleteKanaSession("delete-me", { env, cwd })).toBe(true);
    expect(existsSync(session.path)).toBe(false);
    expect(listKanaSessions({ env, cwd })).toEqual([]);
    expect(() => loadKanaSession("delete-me", { env, cwd })).toThrow(
      "Kana session not found: delete-me",
    );
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-session-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".kana"), { recursive: true });

  return {
    HOME: home,
  };
}
