import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextCheckpoint } from "@/agent";
import { createMessageIdentity, type Message } from "@/core";
import {
  appendKanaSessionMessages,
  appendKanaSessionRun,
  createKanaSession,
  listKanaSessions,
  loadKanaSession,
} from "@/kana";
import { messageIdentityForTest } from "../../helpers/messages";
import { createSessionFixture } from "./session-fixture";

const { cleanupTempDirs, createTempEnv } = createSessionFixture();

describe("Kana session format", () => {
  afterEach(cleanupTempDirs);

  test("keeps the V5 JSONL byte layout stable", () => {
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
          version: 5,
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
    expect(header).toMatchObject({ version: 5, id: "byte-layout" });
  });

  test("round-trips images and usage without duplicating tool images in result metadata", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "tool-images" });
    const messages: Message[] = [
      {
        ...messageIdentityForTest("user"),
        role: "user",
        content: "Inspect the screenshot.",
        images: [
          {
            mimeType: "image/png",
            data: "dXNlci1pbWFnZS1ieXRlcw==",
            width: 16,
            height: 8,
          },
        ],
      },
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
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

  test("round-trips bounded tool-result artifact metadata without a structured result", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "tool-artifact" });
    const locator = path.join(env.KANA_HOME ?? "", "artifacts", "tool-result.txt");
    const message: Message = {
      ...messageIdentityForTest("tool"),
      role: "tool",
      toolCallId: "call-large",
      toolName: "bash",
      content: `Bounded preview\nFull output locator: ${locator}`,
      artifact: { kind: "text", locator, byteLength: 50_000 },
      isError: false,
    };

    appendKanaSessionMessages(session, [message]);

    const loaded = loadKanaSession(session.id, { env, cwd });
    expect(loaded.messages).toEqual([message]);
    expect(loaded.messages[0]).not.toHaveProperty("result");
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
        ...createMessageIdentity({
          kind: "goal_continuation",
          goalId: "goal-1",
          round: 2,
        }),
        role: "user",
        content: "[Goal continuation]\nContinue the active goal.",
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

  test("does not list or load pre-V5 sessions", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    for (const version of [1, 2, 3, 4]) {
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
    for (const version of [1, 2, 3, 4]) {
      expect(() => loadKanaSession(`legacy-v${version}`, { env, cwd })).toThrow(
        `Kana session not found: legacy-v${version}`,
      );
    }
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
});
