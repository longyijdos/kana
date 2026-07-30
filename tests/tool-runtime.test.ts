import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { ToolRuntime } from "../src/agent/tool-runtime";
import type { Logger, LogMetadata } from "../src/logging";
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

  test("supplies an invocation signal and records a cooperative deadline as timed out", async () => {
    let receivedSignal: AbortSignal | undefined;
    const tool = {
      name: "cooperative",
      description: "Stop when canceled.",
      parameters,
      execution: {
        deadlineMs: 5,
      },
      execute: (_args, context) => {
        receivedSignal = context.signal;
        return new Promise((resolve) => {
          context.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                content: "stopped",
                result: { stopped: true },
              });
            },
            { once: true },
          );
        });
      },
    } satisfies Tool<typeof parameters, { stopped: boolean }>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        cancellationGraceMs: 50,
      },
      () => {},
    );

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "call-1",
        name: "cooperative",
        args: {},
      },
    ]);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(result.abortRun).toBe(true);
    expect(result.toolResults[0]).toMatchObject({
      toolCallId: "call-1",
      isError: true,
      result: {
        status: "timed_out",
        reason: "deadline",
        deadlineMs: 5,
      },
    });
  });

  test("returns an unknown result after cancellation grace and ignores late updates", async () => {
    const logs: Array<{ event: string; metadata?: LogMetadata }> = [];
    const events: string[] = [];
    let finishTool!: () => void;
    const tool = {
      name: "stubborn",
      description: "Ignore cancellation.",
      parameters,
      execution: {
        deadlineMs: 5,
      },
      execute: (_args, context) =>
        new Promise((resolve) => {
          finishTool = () => {
            context.update("late secret update");
            resolve({
              content: "late secret result",
              result: { secret: "late result" },
            });
          };
        }),
    } satisfies Tool<typeof parameters, { secret: string }>;
    const logger = createRecordingLogger(logs);
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        cancellationGraceMs: 5,
        logger,
        loggerMetadata: {
          component: "test",
        },
      },
      (event) => {
        events.push(event.type);
      },
    );

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "call-1",
        name: "stubborn",
        args: { secret: "tool argument" },
      },
    ]);

    expect(result).toMatchObject({
      abortRun: true,
      toolResults: [
        {
          toolCallId: "call-1",
          isError: true,
          result: {
            status: "unknown",
            reason: "deadline",
            deadlineMs: 5,
          },
        },
      ],
    });
    expect(events).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(logs.map((record) => record.event)).toEqual([
      "tool.execution_cancellation_requested",
      "tool.execution_orphaned",
    ]);

    finishTool();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(logs.at(-1)).toEqual({
      event: "tool.execution_orphan_settled",
      metadata: {
        component: "test",
        toolName: "stubborn",
        reason: "deadline",
        outcome: "fulfilled",
      },
    });
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("tool argument");
    expect(serializedLogs).not.toContain("late secret update");
    expect(serializedLogs).not.toContain("late secret result");
  });

  test("run cancellation uses the same bounded orphan contract", async () => {
    const controller = new AbortController();
    let finishTool!: () => void;
    const tool = {
      name: "stubborn",
      description: "Ignore cancellation.",
      parameters,
      execute: () =>
        new Promise((resolve) => {
          finishTool = () => resolve("late");
        }),
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        signal: controller.signal,
        cancellationGraceMs: 5,
      },
      (event) => {
        if (event.type === "tool_execution_start") {
          controller.abort();
        }
      },
    );

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "call-1",
        name: "stubborn",
        args: {},
      },
    ]);
    finishTool();

    expect(result).toMatchObject({
      abortRun: true,
      toolResults: [
        {
          result: {
            status: "unknown",
            reason: "run_aborted",
          },
        },
      ],
    });
  });

  test("rejects invalid deadline metadata without executing the tool", async () => {
    let executed = false;
    const tool = {
      name: "invalid",
      description: "Use invalid metadata.",
      parameters,
      execution: {
        deadlineMs: 0,
      },
      execute: () => {
        executed = true;
        return "unexpected";
      },
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime({ tools: [tool] }, () => {});

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "call-1",
        name: "invalid",
        args: {},
      },
    ]);

    expect(executed).toBe(false);
    expect(result.toolResults[0]).toMatchObject({
      isError: true,
      result: {
        error: 'Tool "invalid" execution.deadlineMs must be a positive integer.',
      },
    });
  });
});

function createRecordingLogger(records: Array<{ event: string; metadata?: LogMetadata }>): Logger {
  const record = (event: string, metadata?: LogMetadata): void => {
    records.push({ event, metadata });
  };

  return {
    debug: record,
    info: record,
    warn: record,
    error: record,
  };
}
