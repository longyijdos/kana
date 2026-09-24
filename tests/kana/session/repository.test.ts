import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Message } from "@/core";
import {
  appendKanaSessionMessages,
  appendKanaSessionRun,
  createKanaSession,
  createKanaSessionJournal,
  deleteKanaSession,
  getKanaConfigPaths,
  listKanaSessions,
  loadKanaSession,
} from "@/kana";
import { messageIdentityForTest } from "../../helpers/messages";
import { createSessionFixture } from "./session-fixture";

const { cleanupTempDirs, createTempEnv } = createSessionFixture();

describe("Kana session repository", () => {
  afterEach(cleanupTempDirs);

  test("creates session metadata without writing a JSONL file", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "empty-session" });

    expect(existsSync(session.path)).toBe(false);
    expect(listKanaSessions({ env, cwd })).toEqual([]);
  });

  test("creates a JSONL session on first append and reloads it by id", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "session-1" });
    const messages: Message[] = [
      { ...messageIdentityForTest("user"), role: "user", content: "hi" },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "hello" }],
      },
    ];

    appendKanaSessionMessages(session, messages, {
      timestamp: "2026-06-12T00:00:00.000Z",
    });

    const loaded = loadKanaSession("session-1", { env, cwd });
    const header = JSON.parse(readFileSync(session.path, "utf8").split("\n")[0] ?? "{}") as Record<
      string,
      unknown
    >;

    expect(existsSync(session.path)).toBe(true);
    expect(header).toMatchObject({ type: "session", version: 6, id: "session-1" });
    expect(header.model).toBeUndefined();
    expect(loaded.metadata).toEqual({
      ...session,
      updatedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(loaded.messages).toEqual(messages);
    expect(loaded.timeline.map((entry) => entry.type)).toEqual([
      "turn_start",
      "message",
      "message",
      "turn_end",
    ]);
    expect(session.title).toBe("hi");
    expect(loaded.contextCheckpoint).toBeUndefined();
  });
  test("identifies unknown message and checkpoint references in corrupted sessions", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "corrupted-compaction" });
    const messages: Message[] = [
      { ...messageIdentityForTest("user"), role: "user", content: "Question" },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Answer" }],
      },
    ];
    appendKanaSessionRun(session, messages, {
      compactions: [
        {
          id: "compact-corrupted",
          summary: "Exchange.",
          coveredMessageCount: 2,
          createdAfterMessageCount: 2,
          compactedMessageCount: 2,
          reason: "manual",
          beforeTokens: 1_000,
          estimatedAfterTokens: 100,
          createdAt: "2026-07-24T00:00:01.000Z",
        },
      ],
    });
    const lines = readFileSync(session.path, "utf8").trim().split("\n");
    const compaction = JSON.parse(lines[4] ?? "{}") as Record<string, unknown>;

    compaction.coversThroughId = "missing-message";
    writeFileSync(
      session.path,
      `${[...lines.slice(0, 4), JSON.stringify(compaction), ...lines.slice(5)].join("\n")}\n`,
    );
    expect(() => loadKanaSession(session.id, { env, cwd })).toThrow(
      "compact-corrupted references unknown message missing-message",
    );

    compaction.coversThroughId = JSON.parse(lines[3] ?? "{}").id;
    compaction.baseCompactionId = "missing-checkpoint";
    writeFileSync(
      session.path,
      `${[...lines.slice(0, 4), JSON.stringify(compaction), ...lines.slice(5)].join("\n")}\n`,
    );
    expect(() => loadKanaSession(session.id, { env, cwd })).toThrow(
      "compact-corrupted references unknown checkpoint missing-checkpoint",
    );
  });

  test("lists sessions from the configured Kana home", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const first = createKanaSession({ cwd, env, id: "first" });
    const second = createKanaSession({ cwd, env, id: "second" });

    appendKanaSessionMessages(first, [
      { ...messageIdentityForTest("user"), role: "user", content: "first" },
    ]);
    appendKanaSessionMessages(second, [
      { ...messageIdentityForTest("user"), role: "user", content: "second" },
    ]);

    expect(new Set(listKanaSessions({ env, cwd }).map((session) => session.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(new Set(listKanaSessions({ env }).map((session) => session.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(getKanaConfigPaths(env).sessionsPath).toContain(".kana/sessions");
  });

  test("orders sessions by last persisted activity rather than creation time", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const first = createKanaSession({ cwd, env, id: "first" });
    const second = createKanaSession({ cwd, env, id: "second" });

    appendKanaSessionMessages(first, [userMessage("first")], {
      timestamp: "2026-06-10T00:00:00.000Z",
    });
    appendKanaSessionMessages(second, [userMessage("second")], {
      timestamp: "2026-06-11T00:00:00.000Z",
    });

    expect(sessionIds(env, cwd)).toEqual(["second", "first"]);

    // Loading only reads: an untouched resume must not reorder the list.
    loadKanaSession("first", { env, cwd });

    expect(sessionIds(env, cwd)).toEqual(["second", "first"]);

    appendKanaSessionMessages(first, [userMessage("more")], {
      timestamp: "2026-06-12T00:00:00.000Z",
    });

    expect(sessionIds(env, cwd)).toEqual(["first", "second"]);
    expect(listKanaSessions({ env, cwd })[0]?.updatedAt).toBe("2026-06-12T00:00:00.000Z");
  });

  test("ignores an incomplete crash tail when deriving activity", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const interrupted = createKanaSession({ cwd, env, id: "interrupted" });
    const complete = createKanaSession({ cwd, env, id: "complete" });

    appendKanaSessionMessages(interrupted, [userMessage("interrupted")], {
      timestamp: "2026-06-10T00:00:00.000Z",
    });
    appendKanaSessionMessages(complete, [userMessage("complete")], {
      timestamp: "2026-06-11T00:00:00.000Z",
    });
    appendFileSync(
      interrupted.path,
      '{"type":"message","id":"crash-tail","timestamp":"2026-06-20T00:00:00.000Z"',
    );

    const sessions = listKanaSessions({ env, cwd });

    expect(sessions.map((session) => session.id)).toEqual(["complete", "interrupted"]);
    expect(sessions.map((session) => session.updatedAt)).toEqual([
      "2026-06-11T00:00:00.000Z",
      "2026-06-10T00:00:00.000Z",
    ]);
  });

  test("records parent session paths when a session is first appended", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const messages: Message[] = [
      {
        ...messageIdentityForTest("user"),
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
        ...messageIdentityForTest("user"),
        role: "user",
        content: "this prompt should not replace the explicit title",
      },
    ]);

    const loaded = loadKanaSession("titled", { env, cwd });

    expect(loaded.metadata.title).toBe("Compare parser approaches");
  });

  test("repairs only an incomplete final JSONL record before recovering the turn", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "partial-tail" });
    const journal = createKanaSessionJournal(session);

    journal.startTurn("turn-partial", [
      { ...messageIdentityForTest("user"), role: "user", content: "Hello" },
    ]);
    const validContent = readFileSync(session.path, "utf8");
    writeFileSync(session.path, `${validContent}{"type":"message","id":`);

    const loaded = loadKanaSession(session.id, { env, cwd });

    expect(loaded.recoveredIncompleteTail).toBe(true);
    expect(loaded.recoveredInterruptedTurn).toEqual({
      turnId: "turn-partial",
      unknownToolCallCount: 0,
    });
    expect(readFileSync(session.path, "utf8")).not.toContain('{"type":"message","id":\n');
    expect(loaded.timeline.at(-1)).toMatchObject({
      type: "turn_end",
      outcome: "interrupted",
    });
  });

  test("deletes sessions by id", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "delete-me" });

    appendKanaSessionMessages(session, [
      { ...messageIdentityForTest("user"), role: "user", content: "remove this" },
    ]);

    expect(deleteKanaSession("missing", { env, cwd })).toBe(false);
    expect(deleteKanaSession("delete-me", { env, cwd })).toBe(true);
    expect(existsSync(session.path)).toBe(false);
    expect(listKanaSessions({ env, cwd })).toEqual([]);
    expect(() => loadKanaSession("delete-me", { env, cwd })).toThrow(
      "Kana session not found: delete-me",
    );
  });
});

function userMessage(content: string): Message {
  return { ...messageIdentityForTest("user"), role: "user", content };
}

function sessionIds(env: NodeJS.ProcessEnv, cwd: string): string[] {
  return listKanaSessions({ env, cwd }).map((session) => session.id);
}
