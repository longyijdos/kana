import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextCheckpoint } from "@/agent";
import { createMessageIdentity, type Message } from "@/core";
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana session persistence", () => {
  test("creates session metadata without writing a JSONL file", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "empty-session" });

    expect(existsSync(session.path)).toBe(false);
    expect(listKanaSessions({ env, cwd })).toEqual([]);
  });

  test("keeps the V4 JSONL byte layout stable", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "byte-layout" });
    const timestamp = "2026-07-31T00:00:00.000Z";
    const userMessage = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Byte layout",
    };

    appendKanaSessionMessages(session, [userMessage], { timestamp });

    const content = readFileSync(session.path, "utf8");
    const [header, turnStart, message, turnEnd] = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(content).toBe(
      `${[
        {
          type: "session",
          version: 4,
          id: "byte-layout",
          createdAt: session.createdAt,
          title: "Byte layout",
          cwd,
        },
        {
          type: "turn_start",
          id: turnStart?.id,
          parentId: null,
          timestamp,
          turnId: turnStart?.turnId,
          kind: "snapshot",
        },
        {
          type: "message",
          id: message?.id,
          parentId: turnStart?.id,
          timestamp,
          message: userMessage,
        },
        {
          type: "turn_end",
          id: turnEnd?.id,
          parentId: message?.id,
          timestamp,
          turnId: turnStart?.turnId,
          outcome: "snapshot",
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    expect(header).toMatchObject({ version: 4, id: "byte-layout" });
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
        ...messageIdentityForTest("user"),
        role: "user",
        content: "hi",
        images: [
          {
            mimeType: "image/png",
            data: "c2VsZi1jb250YWluZWQtaW1hZ2U=",
            width: 32,
            height: 16,
          },
        ],
      },
      {
        ...messageIdentityForTest("assistant"),
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
    const turnStart = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    const firstEntry = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;
    const secondEntry = JSON.parse(lines[3] ?? "{}") as Record<string, unknown>;
    const turnEnd = JSON.parse(lines[4] ?? "{}") as Record<string, unknown>;

    expect(loaded.metadata).toEqual(session);
    expect(loaded.messages).toEqual(messages);
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "session",
      version: 4,
      id: "session-1",
      title: "hi",
      cwd,
      model: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    });
    expect(session.title).toBe("hi");
    expect(turnStart).toMatchObject({
      type: "turn_start",
      parentId: null,
      timestamp: "2026-06-12T00:00:00.000Z",
      kind: "snapshot",
    });
    expect(firstEntry).toMatchObject({
      type: "message",
      parentId: turnStart.id,
      timestamp: "2026-06-12T00:00:00.000Z",
      message: {
        role: "user",
        images: [
          {
            mimeType: "image/png",
            data: "c2VsZi1jb250YWluZWQtaW1hZ2U=",
            width: 32,
            height: 16,
          },
        ],
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
    expect(turnEnd).toMatchObject({
      type: "turn_end",
      parentId: secondEntry.id,
      turnId: turnStart.turnId,
      outcome: "snapshot",
    });
    expect(loaded.timeline).toHaveLength(4);
    expect(loaded.contextCheckpoint).toBeUndefined();
  });

  test("round-trips tool image observations in JSONL without duplicating them in result metadata", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "tool-images" });
    const messages: Message[] = [
      { ...messageIdentityForTest("user"), role: "user", content: "Inspect the screenshot." },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-view",
            name: "view_image",
            args: { path: "screenshot.png" },
          },
        ],
      },
      {
        ...messageIdentityForTest("tool"),
        role: "tool",
        toolCallId: "call-view",
        toolName: "view_image",
        content: "Viewed screenshot.png",
        images: [
          {
            mimeType: "image/png",
            data: "dG9vbC1pbWFnZS1ieXRlcw==",
            width: 32,
            height: 16,
          },
        ],
        result: { path: "screenshot.png", width: 32, height: 16 },
        isError: false,
      },
    ];

    appendKanaSessionMessages(session, messages);

    const loaded = loadKanaSession(session.id, { env, cwd });
    const toolLine = readFileSync(session.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: Message })
      .find((entry) => entry.message?.role === "tool");
    const persistedToolMessage = toolLine?.message;
    if (persistedToolMessage?.role !== "tool") {
      throw new Error("Expected a persisted tool message.");
    }
    expect(loaded.messages).toEqual(messages);
    expect(persistedToolMessage).toEqual(messages[2] as Extract<Message, { role: "tool" }>);
    expect(JSON.stringify(persistedToolMessage.result)).not.toContain("dG9vbC1pbWFnZS1ieXRlcw==");
  });

  test("round-trips internal context without using it as the session title", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "runtime-context" });
    const messages: Message[] = [
      {
        ...createMessageIdentity({ kind: "tool_result_policy", source: "repeated_tool_call" }),
        role: "user",
        content: "Internal policy reminder",
      },
      {
        ...createMessageIdentity({ kind: "runtime_context", source: "environment" }),
        role: "user",
        content: '<runtime_context source="environment">dynamic</runtime_context>',
      },
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Visible title",
      },
    ];

    appendKanaSessionMessages(session, messages);

    const loaded = loadKanaSession("runtime-context", { env, cwd });
    expect(loaded.messages).toEqual(messages);
    expect(loaded.metadata.title).toBe("Visible title");
  });

  test("rejects duplicate logical message IDs before writing a session", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "duplicate-message-id" });
    const message = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "Do not write twice.",
    };

    expect(() => appendKanaSessionMessages(session, [message, message])).toThrow(
      "Duplicate Kana logical message id",
    );
    expect(existsSync(session.path)).toBe(false);
  });

  test("persists manual compaction checkpoints without deleting covered messages", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "compacted" });
    const messages: Message[] = [
      { ...messageIdentityForTest("user"), role: "user", content: "Old question" },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Old answer" }],
      },
      { ...messageIdentityForTest("user"), role: "user", content: "Recent question" },
      {
        ...messageIdentityForTest("assistant"),
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
    const compaction = loaded.timeline.at(-2);

    expect(loaded.messages).toEqual(messages);
    expect(loaded.timeline).toHaveLength(7);
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
    expect(compaction).toHaveProperty("coversThroughId", loaded.timeline[2]?.id);
    expect(loaded.contextCheckpoint).toEqual(checkpoint);
  });

  test("links cumulative checkpoints and resumes from the latest summary", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "checkpoint-chain" });
    const firstMessages: Message[] = [
      { ...messageIdentityForTest("user"), role: "user", content: "First question" },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "First answer" }],
      },
      { ...messageIdentityForTest("user"), role: "user", content: "Second question" },
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
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Second answer" }],
      },
      { ...messageIdentityForTest("user"), role: "user", content: "Third question" },
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

  test("does not list or load obsolete v1 and v2 sessions", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    for (const version of [1, 2]) {
      const session = createKanaSession({ cwd, env, id: `legacy-v${version}` });
      mkdirSync(path.dirname(session.path), { recursive: true });
      writeFileSync(
        session.path,
        `${JSON.stringify({
          type: "session",
          version,
          id: session.id,
          createdAt: session.createdAt,
          title: "Legacy",
          cwd,
        })}\n`,
        { mode: 0o600 },
      );
    }

    expect(listKanaSessions({ env, cwd })).toEqual([]);
    expect(() => loadKanaSession("legacy-v1", { env, cwd })).toThrow(
      "Kana session not found: legacy-v1",
    );
    expect(() => loadKanaSession("legacy-v2", { env, cwd })).toThrow(
      "Kana session not found: legacy-v2",
    );
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

  test("rejects malformed user image attachments while loading", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "invalid-images" });
    appendKanaSessionMessages(session, [
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Inspect this.",
        images: [
          {
            mimeType: "image/png",
            data: "aW1hZ2U=",
            width: 32,
            height: 16,
          },
        ],
      },
    ]);
    const originalLines = readFileSync(session.path, "utf8").trim().split("\n");
    const invalidImages: unknown[] = [
      { mimeType: "image/png", data: "aW1hZ2U=", width: 32, height: 16 },
      [{ mimeType: "image/svg+xml", data: "aW1hZ2U=", width: 32, height: 16 }],
      [{ mimeType: "image/png", data: 123, width: 32, height: 16 }],
      [{ mimeType: "image/png", data: "aW1hZ2U=", width: 0, height: 16 }],
      [{ mimeType: "image/png", data: "aW1hZ2U=", width: 32, height: 1.5 }],
    ];

    for (const images of invalidImages) {
      const lines = [...originalLines];
      const entry = JSON.parse(lines[2] ?? "{}") as {
        message?: Record<string, unknown>;
      };
      if (!entry.message) {
        throw new Error("Expected a persisted user message.");
      }
      entry.message.images = images;
      lines[2] = JSON.stringify(entry);
      writeFileSync(session.path, `${lines.join("\n")}\n`);

      expect(() => loadKanaSession(session.id, { env, cwd })).toThrow(
        "Invalid Kana session message entry",
      );
    }
  });

  test("rejects malformed tool image observations while loading", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "invalid-tool-images" });
    appendKanaSessionMessages(session, [
      {
        ...messageIdentityForTest("tool"),
        role: "tool",
        toolCallId: "call-view",
        toolName: "view_image",
        content: "Viewed image",
        images: [{ mimeType: "image/png", data: "aW1hZ2U=", width: 32, height: 16 }],
        result: {},
        isError: false,
      },
    ]);
    const lines = readFileSync(session.path, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[2] ?? "{}") as { message?: Record<string, unknown> };
    if (!entry.message) {
      throw new Error("Expected a persisted tool message.");
    }
    entry.message.images = [{ mimeType: "image/svg+xml", data: "aW1hZ2U=", width: 32, height: 16 }];
    lines[2] = JSON.stringify(entry);
    writeFileSync(session.path, `${lines.join("\n")}\n`);

    expect(() => loadKanaSession(session.id, { env, cwd })).toThrow(
      "Invalid Kana session message entry",
    );
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

  test("journals an agent turn incrementally and reloads the closed turn", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "journaled" });
    const journal = createKanaSessionJournal(session);

    journal.startTurn(
      "turn-1",
      [{ ...messageIdentityForTest("user"), role: "user", content: "Run it" }],
      {
        timestamp: "2026-07-30T00:00:00.000Z",
      },
    );
    journal.appendMessage(
      "turn-1",
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Done" }],
      },
      { timestamp: "2026-07-30T00:00:01.000Z" },
    );
    journal.endTurn("turn-1", "stop", {
      timestamp: "2026-07-30T00:00:02.000Z",
    });

    const loaded = loadKanaSession(session.id, { env, cwd });

    expect(loaded.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(loaded.timeline.map((entry) => entry.type)).toEqual([
      "turn_start",
      "message",
      "message",
      "turn_end",
    ]);
    expect(loaded.timeline.at(-1)).toMatchObject({
      type: "turn_end",
      turnId: "turn-1",
      outcome: "stop",
    });
    expect(loaded.recoveredInterruptedTurn).toBeUndefined();
  });

  test("recovers an interrupted tool call once with an unknown result", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "interrupted" });
    const journal = createKanaSessionJournal(session);

    journal.startTurn("turn-interrupted", [
      { ...messageIdentityForTest("user"), role: "user", content: "Deploy it" },
    ]);
    journal.appendMessage("turn-interrupted", {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "tool_call",
          id: "call-1",
          name: "deploy",
          args: {},
        },
      ],
    });

    const firstLoad = loadKanaSession(session.id, { env, cwd });
    const firstLineCount = readFileSync(session.path, "utf8").trim().split("\n").length;
    const secondLoad = loadKanaSession(session.id, { env, cwd });
    const secondLineCount = readFileSync(session.path, "utf8").trim().split("\n").length;

    expect(firstLoad.recoveredInterruptedTurn).toEqual({
      turnId: "turn-interrupted",
      unknownToolCallCount: 1,
    });
    expect(firstLoad.messages.at(-2)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      toolName: "deploy",
      isError: true,
      result: { status: "unknown" },
    });
    expect(firstLoad.messages.at(-1)).toMatchObject({
      role: "user",
      provenance: { kind: "recovery" },
    });
    expect(firstLoad.timeline.at(-1)).toMatchObject({
      type: "turn_end",
      outcome: "interrupted",
    });
    expect(secondLoad.recoveredInterruptedTurn).toBeUndefined();
    expect(secondLineCount).toBe(firstLineCount);
  });

  test("does not replace a recorded tool result while closing an interrupted turn", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "completed-tool" });
    const journal = createKanaSessionJournal(session);

    journal.startTurn("turn-completed-tool", [
      { ...messageIdentityForTest("user"), role: "user", content: "Inspect it" },
    ]);
    journal.appendMessage("turn-completed-tool", {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "tool_call",
          id: "call-recorded",
          name: "read",
          args: { path: "package.json" },
        },
      ],
    });
    journal.appendMessage("turn-completed-tool", {
      ...messageIdentityForTest("tool"),
      role: "tool",
      toolCallId: "call-recorded",
      toolName: "read",
      content: "recorded result",
      result: { status: "completed" },
      isError: false,
    });

    const loaded = loadKanaSession(session.id, { env, cwd });
    const toolMessages = loaded.messages.filter((message) => message.role === "tool");

    expect(loaded.recoveredInterruptedTurn).toEqual({
      turnId: "turn-completed-tool",
      unknownToolCallCount: 0,
    });
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      toolCallId: "call-recorded",
      content: "recorded result",
      result: { status: "completed" },
      isError: false,
    });
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

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-session-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".kana"), { recursive: true });

  return {
    HOME: home,
  };
}
