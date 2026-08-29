import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  appendKanaSessionMessages,
  createKanaSession,
  createKanaSessionJournal,
  type KanaTodoItem,
  loadKanaSession,
} from "@/kana";
import { messageIdentityForTest } from "../../helpers/messages";
import { createSessionFixture } from "./session-fixture";

const { cleanupTempDirs, createTempEnv } = createSessionFixture();

describe("Kana session journal", () => {
  afterEach(cleanupTempDirs);

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

  test("persists accepted todo snapshots and reconstructs the latest whole-list replacement", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "todo-state" });
    const journal = createKanaSessionJournal(session);

    appendTodoTurn(journal, "turn-todo-1", "call-todo-1", [
      { content: "Inspect persistence", status: "completed" },
      { content: "Implement replay", status: "in_progress" },
    ]);
    appendTodoTurn(journal, "turn-todo-2", "call-todo-2", [
      { content: "Implement replay", status: "completed" },
    ]);

    const replaced = loadKanaSession(session.id, { env, cwd });
    expect(replaced.todoState).toEqual([{ content: "Implement replay", status: "completed" }]);
    expect(
      replaced.timeline
        .filter((entry) => entry.type === "todo_state")
        .map((entry) => ({ toolCallId: entry.toolCallId, items: entry.items })),
    ).toEqual([
      {
        toolCallId: "call-todo-1",
        items: [
          { content: "Inspect persistence", status: "completed" },
          { content: "Implement replay", status: "in_progress" },
        ],
      },
      {
        toolCallId: "call-todo-2",
        items: [{ content: "Implement replay", status: "completed" }],
      },
    ]);
    expect(
      replaced.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content),
    ).toEqual(["Todo list updated.", "Todo list updated."]);

    appendTodoTurn(journal, "turn-todo-clear", "call-todo-clear", []);
    const cleared = loadKanaSession(session.id, { env, cwd });
    expect(cleared.todoState).toEqual([]);
    expect(cleared.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-todo-clear",
      content: "Todo list cleared.",
      result: { status: "cleared" },
    });
  });

  test("recovers a durably accepted todo call without downgrading it to unknown", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const session = createKanaSession({ cwd, env, id: "interrupted-todo" });
    const journal = createKanaSessionJournal(session);
    const items: KanaTodoItem[] = [{ content: "Resume safely", status: "in_progress" }];

    journal.startTurn("turn-interrupted-todo", [
      { ...messageIdentityForTest("user"), role: "user", content: "Track the work" },
    ]);
    journal.appendMessage("turn-interrupted-todo", {
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "tool_call",
          id: "call-interrupted-todo",
          name: "todo_write",
          args: { items },
        },
      ],
    });
    journal.appendTodoState("turn-interrupted-todo", "call-interrupted-todo", items);

    const loaded = loadKanaSession(session.id, { env, cwd });

    expect(loaded.todoState).toEqual(items);
    expect(loaded.recoveredInterruptedTurn).toEqual({
      turnId: "turn-interrupted-todo",
      unknownToolCallCount: 0,
    });
    expect(loaded.messages.at(-2)).toMatchObject({
      role: "tool",
      toolCallId: "call-interrupted-todo",
      content: "Todo list updated.",
      result: { status: "updated" },
      isError: false,
    });
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
});

function appendTodoTurn(
  journal: ReturnType<typeof createKanaSessionJournal>,
  turnId: string,
  toolCallId: string,
  items: KanaTodoItem[],
): void {
  journal.startTurn(turnId, [
    { ...messageIdentityForTest("user"), role: "user", content: `Update ${toolCallId}` },
  ]);
  journal.appendMessage(turnId, {
    ...messageIdentityForTest("assistant"),
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "tool_call", id: toolCallId, name: "todo_write", args: { items } }],
  });
  journal.appendTodoState(turnId, toolCallId, items);
  journal.appendMessage(turnId, {
    ...messageIdentityForTest("tool"),
    role: "tool",
    toolCallId,
    toolName: "todo_write",
    content: items.length === 0 ? "Todo list cleared." : "Todo list updated.",
    result: { status: items.length === 0 ? "cleared" : "updated" },
    isError: false,
  });
  journal.endTurn(turnId, "stop");
}
