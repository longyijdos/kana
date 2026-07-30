import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { ToolRuntime } from "../src/agent/tool-runtime";
import type { Tool } from "../src/tools/tool";

const parameters = Type.Object({});

describe("ToolRuntime", () => {
  test("serializes update events and commits the result before publishing end", async () => {
    const operations: string[] = [];
    const tool = {
      name: "progress",
      description: "Report progress.",
      parameters,
      execute: (_args, context) => {
        operations.push("execute");
        context.update("first");
        context.update("second");
        return {
          content: "done",
          result: { status: "done" },
        };
      },
    } satisfies Tool<typeof parameters, { status: string }>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        onMessageCommitted: (message) => {
          operations.push(`commit:${message.role}`);
        },
      },
      async (event) => {
        if (event.type === "tool_execution_start") {
          operations.push("start");
        }
        if (event.type === "tool_execution_update") {
          operations.push(`update:${event.partialResult}:start`);
          if (event.partialResult === "first") {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          operations.push(`update:${event.partialResult}:end`);
        }
        if (event.type === "tool_execution_end") {
          operations.push("end");
        }
      },
    );

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "call-1",
        name: "progress",
        args: {},
      },
    ]);

    expect(operations).toEqual([
      "start",
      "execute",
      "update:first:start",
      "update:first:end",
      "update:second:start",
      "update:second:end",
      "commit:tool",
      "end",
    ]);
    expect(result).toEqual({
      toolResults: [
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "progress",
          content: "done",
          result: { status: "done" },
          isError: false,
        },
      ],
      abortRun: false,
    });
  });

  test("does not publish tool end when the result commit fails", async () => {
    const events: string[] = [];
    const commitError = new Error("journal unavailable");
    const tool = {
      name: "side_effect",
      description: "Perform a side effect.",
      parameters,
      execute: () => "completed",
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        onMessageCommitted: () => {
          throw commitError;
        },
      },
      (event) => {
        events.push(event.type);
      },
    );

    await expect(
      runtime.execute([
        {
          type: "tool_call",
          id: "call-1",
          name: "side_effect",
          args: {},
        },
      ]),
    ).rejects.toBe(commitError);

    expect(events).toEqual(["tool_execution_start"]);
  });
});
