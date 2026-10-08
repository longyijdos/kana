import { describe, expect, test } from "bun:test";
import { createMessageIdentity, createUserMessage } from "../../src/core";
import type { KanaSessionTimelineEntry } from "../../src/kana";
import { ServerProjection } from "../../src/server/projection";
import { projectMessage, projectTimelineEntry, stringifyJson } from "../../src/server/protocol";
import { createFixture } from "./fixture";

describe("server event projection", () => {
  test("strips provider replay state without changing Core content", () => {
    const message = {
      ...createMessageIdentity({ kind: "model_output" }),
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "Visible",
          providerState: { provider: "test", value: "opaque" },
        },
      ],
    };
    expect(projectMessage(message).content).toEqual([{ type: "text", text: "Visible" }]);
    expect(message.content[0]!.providerState.value).toBe("opaque");
    const entry = projectTimelineEntry({
      type: "message",
      id: "entry",
      parentId: null,
      timestamp: "now",
      message,
    });
    expect(entry).toEqual({
      type: "message",
      id: "entry",
      parentId: null,
      timestamp: "now",
      message_id: message.id,
    });
  });

  test("passes detached messages and non-message timeline entries through projection", () => {
    const message = createUserMessage({
      content: "Owned input",
      provenance: { kind: "user_input" },
    });
    const entry: KanaSessionTimelineEntry = {
      type: "todo_state",
      id: "todo",
      parentId: null,
      timestamp: "now",
      items: [{ content: "Owned todo", status: "pending" }],
    };
    expect(projectMessage(message)).toBe(message);
    expect(projectTimelineEntry(entry)).toBe(entry);
  });

  test("serializes nested BigInt values without mutating the original result", () => {
    const result = {
      count: 9_007_199_254_740_993n,
      nested: { negative: -2n },
      values: [0n, null, "text", 2],
    };
    expect(JSON.parse(stringifyJson(result))).toEqual({
      count: "9007199254740993",
      nested: { negative: "-2" },
      values: ["0", null, "text", 2],
    });
    expect(result.count).toBe(9_007_199_254_740_993n);
    expect(result.nested.negative).toBe(-2n);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => stringifyJson(cyclic)).toThrow();
  });

  test("projects calibrated context estimates and configured limits from the runtime", async () => {
    const user = createUserMessage({
      content: "Earlier question",
      provenance: { kind: "user_input" },
    });
    const assistant = {
      ...createMessageIdentity({ kind: "model_output" }),
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Earlier answer" }],
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    };
    const f = createFixture({
      session: { id: "history", messages: [user, assistant], timeline: [] },
      context: { contextLimit: 32_000, maxOutputTokens: 512 },
    });
    try {
      const projection = new ServerProjection(f.runtime, () => {});
      const context = projection.snapshot().context;
      expect(context).toEqual({
        estimated_tokens: f.runtime.state.estimatedContextTokens ?? null,
        context_limit: 32_000,
      });
      expect(context.estimated_tokens).toBeGreaterThan(100);
      context.estimated_tokens = 0;
      expect(projection.snapshot().context.estimated_tokens).toBeGreaterThan(100);
    } finally {
      await f.close();
    }
  });

  test("uses null for unavailable context estimates and the model's default limit", async () => {
    const f = createFixture();
    const events: Array<{ type: string; data: unknown }> = [];
    const projection = new ServerProjection(f.runtime, (type, data) => events.push({ type, data }));
    try {
      const context = { estimated_tokens: null, context_limit: 128_000 };
      expect(projection.snapshot().context).toEqual(context);
      projection.handle({ type: "agent_event", source: "user", event: { type: "agent_start" } });
      expect(events).toEqual([{ type: "context.updated", data: context }]);
    } finally {
      await f.close();
    }
  });

  test("publishes the latest model-turn estimate before run completion and refreshes session context", async () => {
    const f = createFixture({ context: { contextLimit: 32_000, maxOutputTokens: 512 } });
    const events: Array<{ type: string; data: unknown }> = [];
    const projection = new ServerProjection(f.runtime, (type, data) => events.push({ type, data }));
    const unsubscribe = f.runtime.subscribe((event) => projection.handle(event));
    try {
      const initialContext = projection.snapshot().context;
      projection.handle({
        type: "agent_event",
        source: "user",
        event: {
          type: "turn_end",
          turn: 1,
          message: {
            ...createMessageIdentity({ kind: "model_output" }),
            role: "assistant",
            content: [],
          },
          toolResults: [],
          estimatedContextTokens: 321,
        },
      });
      expect(events.at(-1)).toEqual({
        type: "context.updated",
        data: { estimated_tokens: 321, context_limit: 32_000 },
      });
      await f.runtime.submit(
        createUserMessage({ content: "Hello", provenance: { kind: "user_input" } }),
      );
      const context = projection.snapshot().context;
      expect(context.estimated_tokens).toBeGreaterThan(initialContext.estimated_tokens!);
      const completed = events.map((event) => event.type).lastIndexOf("run.completed");
      expect(events[completed - 1]).toEqual({ type: "context.updated", data: context });
      await f.runtime.startNewSession();
      const changed = events.map((event) => event.type).lastIndexOf("session.changed");
      expect(events[changed + 1]).toEqual({
        type: "context.updated",
        data: initialContext,
      });
      expect(events[changed + 1]?.data).toEqual(projection.snapshot().context);
    } finally {
      unsubscribe();
      await f.close();
    }
  });

  test("publishes compacted context without counting the retained transcript as active context", async () => {
    const messages = [
      createUserMessage({ content: "old ".repeat(2_000), provenance: { kind: "user_input" } }),
      {
        ...createMessageIdentity({ kind: "model_output" }),
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Earlier answer" }],
      },
    ];
    const f = createFixture({
      session: { id: "history", messages, timeline: [] },
      context: {
        contextLimit: 2_048,
        maxOutputTokens: 256,
        compactPolicy: () => ({ summary: "Earlier conversation." }),
      },
    });
    const events: Array<{ type: string; data: unknown }> = [];
    const projection = new ServerProjection(f.runtime, (type, data) => events.push({ type, data }));
    const unsubscribe = f.runtime.subscribe((event) => projection.handle(event));
    try {
      const before = projection.snapshot().context;
      await f.runtime.compact();
      const snapshot = projection.snapshot();
      expect(snapshot.context.estimated_tokens).toBeLessThan(before.estimated_tokens!);
      expect(snapshot.context.context_limit).toBe(2_048);
      expect(snapshot.session!.messages).toEqual(messages);
      const updates = events.filter((event) => event.type === "context.updated");
      expect(updates.map((event) => event.data)).toEqual([
        before,
        snapshot.context,
        snapshot.context,
      ]);
      expect(events.at(-2)).toEqual({ type: "context.updated", data: snapshot.context });
      expect(events.at(-1)?.type).toBe("run.completed");
    } finally {
      unsubscribe();
      await f.close();
    }
  });

  test("stores message bodies once while preserving timeline references and event order", async () => {
    const imageData = "aW1hZ2UtcGF5bG9hZA==";
    const user = createUserMessage({
      provenance: { kind: "user_input" },
      content: "Question",
      images: [{ data: imageData, mimeType: "image/png", width: 1, height: 1 }],
    });
    const assistant = {
      ...createMessageIdentity({ kind: "model_output" }),
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "Unique answer payload",
          providerState: { provider: "test", value: "opaque" },
        },
      ],
    };
    const timeline: KanaSessionTimelineEntry[] = [
      {
        type: "turn_start",
        id: "start",
        parentId: null,
        timestamp: "t0",
        turnId: "turn",
        kind: "agent",
      },
      { type: "message", id: "user", parentId: "start", timestamp: "t1", message: user },
      {
        type: "todo_state",
        id: "todo",
        parentId: "user",
        timestamp: "t2",
        items: [{ content: "Original todo", status: "pending" }],
      },
      { type: "message", id: "assistant", parentId: "todo", timestamp: "t3", message: assistant },
      {
        type: "turn_end",
        id: "end",
        parentId: "assistant",
        timestamp: "t4",
        turnId: "turn",
        outcome: "stop",
      },
    ];
    const f = createFixture({ session: { id: "history", messages: [user, assistant], timeline } });
    try {
      const projection = new ServerProjection(f.runtime, () => {});
      const session = projection.snapshot().session!;
      expect(session.messages).toEqual([
        user,
        { ...assistant, content: [{ type: "text", text: "Unique answer payload" }] },
      ]);
      const events = timeline.filter((entry) => entry.type !== "message");
      expect(session.timeline).toEqual([
        events[0],
        { type: "message", id: "user", parentId: "start", timestamp: "t1", message_id: user.id },
        events[1],
        {
          type: "message",
          id: "assistant",
          parentId: "todo",
          timestamp: "t3",
          message_id: assistant.id,
        },
        events[2],
      ]);
      const byId = new Map(session.messages.map((message) => [message.id, message]));
      for (const entry of session.timeline) {
        if (entry.type === "message") {
          expect(byId.has(entry.message_id)).toBe(true);
          expect(entry).not.toHaveProperty("message");
        }
      }
      const serialized = stringifyJson(session);
      expect(serialized.split(imageData)).toHaveLength(2);
      expect(serialized.split("Unique answer payload")).toHaveLength(2);
      expect(serialized).not.toContain("providerState");
      expect(timeline[1]).toMatchObject({ message: user });
      expect(assistant.content[0]!.providerState.value).toBe("opaque");
      const projectedUser = session.messages.find((message) => message.role === "user")!;
      if (projectedUser.role === "user") projectedUser.images![0]!.data = "changed";
      const projectedTodo = session.timeline.find((entry) => entry.type === "todo_state")!;
      if (projectedTodo.type === "todo_state") projectedTodo.items[0]!.content = "changed";
      const next = projection.snapshot().session!;
      expect(next.messages[0]).toEqual(user);
      expect(next.timeline.find((entry) => entry.type === "todo_state")).toEqual(
        timeline.find((entry) => entry.type === "todo_state"),
      );
    } finally {
      await f.close();
    }
  });

  test("keeps outer tool progress, maps failures, and resets transient state on session changes", async () => {
    const f = createFixture();
    const events: Array<{ type: string; data: unknown }> = [];
    const projection = new ServerProjection(f.runtime, (type, data) => {
      events.push({ type, data });
    });
    try {
      projection.handle({ type: "run_start", source: "user" });
      const runId = projection.runId;
      expect(runId).not.toBeNull();
      projection.handle({
        type: "agent_event",
        source: "user",
        event: {
          type: "tool_execution_start",
          toolCallId: "outer",
          toolName: "run_code",
          args: { code: "return 1" },
        },
      });
      projection.handle({
        type: "agent_event",
        source: "user",
        event: {
          type: "tool_execution_update",
          toolCallId: "outer",
          toolName: "run_code",
          args: {},
          partialResult: "Working",
        },
      });
      projection.handle({
        type: "agent_event",
        source: "user",
        event: {
          type: "tool_execution_start",
          toolCallId: "inner",
          parentToolCallId: "outer",
          toolName: "read",
          args: {},
        },
      });
      expect(projection.snapshot().tools).toEqual([
        {
          tool_call_id: "outer",
          name: "run_code",
          status: "running",
          arguments: { code: "return 1" },
          partial_result: "Working",
        },
      ]);
      projection.handle({
        type: "agent_event",
        source: "user",
        event: {
          type: "tool_execution_end",
          toolCallId: "outer",
          toolName: "run_code",
          result: 1,
          isError: false,
        },
      });
      projection.handle({ type: "run_error", source: "user", error: new Error("Journal failed") });
      expect(projection.snapshot().run).toMatchObject({
        id: runId,
        status: "failed",
        error: { name: "Error", message: "Journal failed" },
      });
      expect(events.map((event) => event.type)).toEqual([
        "run.started",
        "tool.started",
        "tool.updated",
        "tool.completed",
        "context.updated",
        "run.failed",
      ]);
      projection.handle({
        type: "session_changed",
        action: "new",
        session: { id: "new", messages: [], timeline: [] },
      });
      expect(projection.snapshot()).toMatchObject({ run: null, assistant: null, tools: [] });
    } finally {
      await f.close();
    }
  });
});
