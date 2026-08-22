import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  DEFAULT_TOOL_DEADLINE_MS,
  ToolRuntime,
} from "../../src/agent/tool-runtime";
import type { Logger, LogMetadata } from "../../src/logging";
import type { Tool } from "../../src/tools/tool";

const parameters = Type.Object({});
const labeledParameters = Type.Object({
  label: Type.String(),
});

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
    expect(result).toMatchObject({
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
    expect(result.toolResults[0]?.id).toBeDefined();
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
        cancellationGraceMs: 5,
        defaultDeadlineMs: 50,
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

  test("applies the configured default deadline when a tool does not declare one", async () => {
    const tool = {
      name: "default_deadline",
      description: "Use the runtime deadline.",
      parameters,
      execute: (_args, context) =>
        new Promise((resolve) => {
          context.signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        cancellationGraceMs: 50,
        defaultDeadlineMs: 5,
      },
      () => {},
    );

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "call-1",
        name: "default_deadline",
        args: {},
      },
    ]);

    expect(result.abortRun).toBe(true);
    expect(result.toolResults[0]).toMatchObject({
      isError: true,
      result: {
        status: "timed_out",
        reason: "deadline",
        deadlineMs: 5,
      },
    });
  });

  test("validates the runtime default deadline", () => {
    expect(DEFAULT_TOOL_DEADLINE_MS).toBe(300_000);
    expect(() => new ToolRuntime({ tools: [], defaultDeadlineMs: 0 }, () => {})).toThrow(
      "defaultDeadlineMs must be a positive integer.",
    );
  });

  test("uses and validates a conservative parallel tool limit", () => {
    expect(DEFAULT_MAX_PARALLEL_TOOL_CALLS).toBe(4);
    expect(() => new ToolRuntime({ tools: [], maxParallelToolCalls: 0 }, () => {})).toThrow(
      "maxParallelToolCalls must be a positive integer.",
    );
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

  test("runs adjacent parallel calls together without crossing exclusive barriers", async () => {
    const operations: string[] = [];
    const finishByLabel = new Map<string, () => void>();
    const createDeferredTool = (name: string, concurrency: "parallel" | "exclusive" | undefined) =>
      ({
        name,
        description: `Run ${name}.`,
        parameters: labeledParameters,
        ...(concurrency === undefined
          ? {}
          : {
              execution: {
                concurrency,
              },
            }),
        execute: ({ label }) =>
          new Promise((resolve) => {
            operations.push(`start:${label}`);
            finishByLabel.set(label, () => {
              operations.push(`finish:${label}`);
              resolve({
                content: label,
                result: { label },
              });
            });
          }),
      }) satisfies Tool<typeof labeledParameters, { label: string }>;
    const runtime = new ToolRuntime(
      {
        tools: [
          createDeferredTool("parallel", "parallel"),
          createDeferredTool("barrier", undefined),
        ],
        maxParallelToolCalls: 2,
        onMessageCommitted: (message) => {
          if (message.role === "tool") {
            operations.push(`commit:${message.toolCallId}`);
          }
        },
      },
      (event) => {
        if (event.type === "tool_execution_end") {
          operations.push(`end:${event.toolCallId}`);
        }
      },
    );

    const execution = runtime.execute([
      toolCall("p1", "parallel"),
      toolCall("p2", "parallel"),
      toolCall("barrier", "barrier"),
      toolCall("p3", "parallel"),
      toolCall("p4", "parallel"),
    ]);

    await waitFor(() => finishByLabel.has("p1") && finishByLabel.has("p2"));
    expect(operations.filter((operation) => operation.startsWith("start:"))).toEqual([
      "start:p1",
      "start:p2",
    ]);

    finishByLabel.get("p2")?.();
    await waitFor(() => operations.includes("end:p2"));
    expect(finishByLabel.has("barrier")).toBe(false);
    finishByLabel.get("p1")?.();

    await waitFor(() => finishByLabel.has("barrier"));
    expect(finishByLabel.has("p3")).toBe(false);
    finishByLabel.get("barrier")?.();

    await waitFor(() => finishByLabel.has("p3") && finishByLabel.has("p4"));
    finishByLabel.get("p4")?.();
    await waitFor(() => operations.includes("end:p4"));
    finishByLabel.get("p3")?.();

    const result = await execution;

    expect(result.toolResults.map((message) => message.toolCallId)).toEqual([
      "p1",
      "p2",
      "barrier",
      "p3",
      "p4",
    ]);
    expect(operations.filter((operation) => operation.startsWith("commit:"))).toEqual([
      "commit:p1",
      "commit:p2",
      "commit:barrier",
      "commit:p3",
      "commit:p4",
    ]);
    expect(operations.filter((operation) => operation.startsWith("end:"))).toEqual([
      "end:p2",
      "end:p1",
      "end:barrier",
      "end:p4",
      "end:p3",
    ]);
  });

  test("runs a bounded rolling pool and logs its lifecycle", async () => {
    const logs: Array<{ event: string; metadata?: LogMetadata }> = [];
    const starts: string[] = [];
    const ends: string[] = [];
    const finishByLabel = new Map<string, () => void>();
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const tool = {
      name: "parallel",
      description: "Run in a bounded pool.",
      parameters: labeledParameters,
      execution: {
        concurrency: "parallel",
      },
      execute: ({ label }) =>
        new Promise((resolve) => {
          starts.push(label);
          activeExecutions += 1;
          maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
          finishByLabel.set(label, () => {
            activeExecutions -= 1;
            resolve(label);
          });
        }),
    } satisfies Tool<typeof labeledParameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        maxParallelToolCalls: 2,
        logger: createRecordingLogger(logs),
      },
      (event) => {
        if (event.type === "tool_execution_end") {
          ends.push(event.toolCallId);
        }
      },
    );

    const execution = runtime.execute([
      toolCall("p1", "parallel"),
      toolCall("p2", "parallel"),
      toolCall("p3", "parallel"),
      toolCall("p4", "parallel"),
    ]);

    await waitFor(() => starts.length === 2);
    expect(starts).toEqual(["p1", "p2"]);
    finishByLabel.get("p2")?.();
    await waitFor(() => starts.includes("p3"));
    finishByLabel.get("p3")?.();
    await waitFor(() => starts.includes("p4"));
    finishByLabel.get("p4")?.();
    finishByLabel.get("p1")?.();

    const result = await execution;

    expect(maximumActiveExecutions).toBe(2);
    expect(starts).toEqual(["p1", "p2", "p3", "p4"]);
    expect(ends).toEqual(["p2", "p3", "p4", "p1"]);
    expect(result.toolResults.map((message) => message.toolCallId)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(logs).toEqual([
      {
        event: "tool.parallel_pool_started",
        metadata: {
          toolCount: 4,
          maxParallelToolCalls: 2,
          workerCount: 2,
        },
      },
      {
        event: "tool.parallel_pool_ended",
        metadata: {
          toolCount: 4,
          maxParallelToolCalls: 2,
          startedCount: 4,
          canceledBeforeStartCount: 0,
          unknownOutcomeCount: 0,
          outcome: "completed",
        },
      },
    ]);
  });

  test("serializes parallel tools when parallel calls are disabled", async () => {
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const tool = {
      name: "parallel",
      description: "Run in parallel when enabled.",
      parameters: labeledParameters,
      execution: {
        concurrency: "parallel",
      },
      execute: async ({ label }) => {
        activeExecutions += 1;
        maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
        await new Promise((resolve) => setTimeout(resolve, 0));
        activeExecutions -= 1;
        return label;
      },
    } satisfies Tool<typeof labeledParameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        parallelToolCalls: false,
        maxParallelToolCalls: 4,
      },
      () => {},
    );

    const result = await runtime.execute([
      toolCall("p1", "parallel"),
      toolCall("p2", "parallel"),
      toolCall("p3", "parallel"),
    ]);

    expect(maximumActiveExecutions).toBe(1);
    expect(result.toolResults.map((message) => message.toolCallId)).toEqual(["p1", "p2", "p3"]);
  });

  test("stops replenishing the pool and cancels queued calls after run abort", async () => {
    const controller = new AbortController();
    const logs: Array<{ event: string; metadata?: LogMetadata }> = [];
    const starts: string[] = [];
    const completed = new Map<string, unknown>();
    const tool = {
      name: "parallel",
      description: "Wait until the run is aborted.",
      parameters: labeledParameters,
      execution: {
        concurrency: "parallel",
      },
      execute: ({ label }, context) =>
        new Promise((resolve) => {
          starts.push(label);
          context.signal?.addEventListener("abort", () => resolve(label), { once: true });
        }),
    } satisfies Tool<typeof labeledParameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        maxParallelToolCalls: 2,
        signal: controller.signal,
        cancellationGraceMs: 50,
        logger: createRecordingLogger(logs),
      },
      (event) => {
        if (event.type === "tool_execution_end") {
          completed.set(event.toolCallId, event.result);
        }
      },
    );

    const execution = runtime.execute([
      toolCall("p1", "parallel"),
      toolCall("p2", "parallel"),
      toolCall("p3", "parallel"),
      toolCall("p4", "parallel"),
    ]);

    await waitFor(() => starts.length === 2);
    controller.abort();
    const result = await execution;

    expect(starts).toEqual(["p1", "p2"]);
    expect(result.abortRun).toBe(true);
    expect(result.toolResults.map((message) => message.toolCallId)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(completed.get("p3")).toMatchObject({ canceled: true });
    expect(completed.get("p4")).toMatchObject({ canceled: true });
    expect(logs.find((record) => record.event === "tool.parallel_pool_abnormal_drain")).toEqual({
      event: "tool.parallel_pool_abnormal_drain",
      metadata: {
        toolCount: 4,
        maxParallelToolCalls: 2,
        startedCount: 2,
        canceledBeforeStartCount: 2,
        unknownOutcomeCount: 0,
        outcome: "aborted",
      },
    });
  });

  test("drains started calls and cancels queued calls after commit failure", async () => {
    const commitError = new Error("journal unavailable");
    const logs: Array<{ event: string; metadata?: LogMetadata }> = [];
    const starts: string[] = [];
    const completed = new Map<string, unknown>();
    let finishFirst!: () => void;
    const tool = {
      name: "parallel",
      description: "Expose scheduler failure behavior.",
      parameters: labeledParameters,
      execution: {
        concurrency: "parallel",
      },
      execute: ({ label }, context) =>
        new Promise((resolve) => {
          starts.push(label);
          if (label === "p1") {
            finishFirst = () => resolve(label);
            return;
          }
          context.signal?.addEventListener("abort", () => resolve(label), { once: true });
        }),
    } satisfies Tool<typeof labeledParameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        maxParallelToolCalls: 2,
        cancellationGraceMs: 5,
        logger: createRecordingLogger(logs),
        onMessageCommitted: () => {
          throw commitError;
        },
      },
      (event) => {
        if (event.type === "tool_execution_end") {
          completed.set(event.toolCallId, event.result);
        }
      },
    );

    const execution = runtime.execute([
      toolCall("p1", "parallel"),
      toolCall("p2", "parallel"),
      toolCall("p3", "parallel"),
      toolCall("p4", "parallel"),
    ]);

    await waitFor(() => starts.length === 2);
    finishFirst();
    await expect(execution).rejects.toBe(commitError);

    expect(starts.slice(0, 2)).toEqual(["p1", "p2"]);
    expect(starts).not.toContain("p4");
    expect(completed.get("p4")).toMatchObject({ canceled: true });
    expect(logs.find((record) => record.event === "tool.parallel_pool_abnormal_drain")).toEqual({
      event: "tool.parallel_pool_abnormal_drain",
      metadata: {
        toolCount: 4,
        maxParallelToolCalls: 2,
        startedCount: 3,
        canceledBeforeStartCount: 1,
        unknownOutcomeCount: 1,
        outcome: "failed",
        errorType: "Error",
      },
    });
  });

  test("serializes approval hooks inside a parallel group", async () => {
    const pendingApprovals: Array<() => void> = [];
    let activeApprovals = 0;
    let maximumActiveApprovals = 0;
    const tool = {
      name: "parallel",
      description: "Run in parallel.",
      parameters: labeledParameters,
      execution: {
        concurrency: "parallel",
      },
      execute: ({ label }) => label,
    } satisfies Tool<typeof labeledParameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        beforeToolExecution: () => {
          activeApprovals += 1;
          maximumActiveApprovals = Math.max(maximumActiveApprovals, activeApprovals);
          return new Promise((resolve) => {
            pendingApprovals.push(() => {
              activeApprovals -= 1;
              resolve({ type: "continue" });
            });
          });
        },
      },
      () => {},
    );

    const execution = runtime.execute([toolCall("p1", "parallel"), toolCall("p2", "parallel")]);

    await waitFor(() => pendingApprovals.length === 1);
    expect(activeApprovals).toBe(1);
    pendingApprovals[0]?.();
    await waitFor(() => pendingApprovals.length === 2);
    expect(activeApprovals).toBe(1);
    pendingApprovals[1]?.();

    const result = await execution;

    expect(maximumActiveApprovals).toBe(1);
    expect(result.toolResults).toHaveLength(2);
  });

  test("cancels parallel siblings when one invocation deadline aborts the run", async () => {
    const deadlineTool = {
      name: "deadline",
      description: "Reach a deadline.",
      parameters,
      execution: {
        concurrency: "parallel",
        deadlineMs: 5,
      },
      execute: (_args, context) =>
        new Promise((resolve) => {
          context.signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool<typeof parameters, string>;
    const siblingTool = {
      name: "sibling",
      description: "Wait for group cancellation.",
      parameters,
      execution: {
        concurrency: "parallel",
      },
      execute: (_args, context) =>
        new Promise((resolve) => {
          context.signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [deadlineTool, siblingTool],
        cancellationGraceMs: 50,
      },
      () => {},
    );

    const result = await runtime.execute([
      {
        type: "tool_call",
        id: "deadline",
        name: "deadline",
        args: {},
      },
      {
        type: "tool_call",
        id: "sibling",
        name: "sibling",
        args: {},
      },
    ]);

    expect(result.abortRun).toBe(true);
    expect(result.toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "deadline",
          result: expect.objectContaining({
            status: "timed_out",
            reason: "deadline",
          }),
        }),
        expect.objectContaining({
          toolCallId: "sibling",
          result: expect.objectContaining({
            status: "canceled",
            reason: "run_aborted",
          }),
        }),
      ]),
    );
  });

  test("fails closed on invalid concurrency metadata", async () => {
    let executed = false;
    const tool = {
      name: "invalid",
      description: "Use invalid metadata.",
      parameters,
      execution: {
        concurrency: "unsafe",
      },
      execute: () => {
        executed = true;
        return "unexpected";
      },
    } as unknown as Tool<typeof parameters, string>;
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
        error: 'Tool "invalid" execution.concurrency must be "parallel" or "exclusive".',
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

function toolCall(id: string, name: string) {
  return {
    type: "tool_call" as const,
    id,
    name,
    args: {
      label: id,
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not met.");
}
