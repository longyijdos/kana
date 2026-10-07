import { describe, expect, test } from "bun:test";
import { createMessageIdentity } from "../../src/core";
import { ServerProjection } from "../../src/server/projection";
import { projectMessage, projectTimelineEntry } from "../../src/server/protocol";
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
    expect(entry.type === "message" && entry.message.content).toEqual([
      { type: "text", text: "Visible" },
    ]);
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
