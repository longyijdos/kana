import { describe, expect, spyOn, test } from "bun:test";
import { Type } from "typebox";
import type { AgentEvent, ToolResultPolicy, ToolResultPolicyInput } from "../../src/agent";
import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  DEFAULT_TOOL_DEADLINE_MS,
  ToolRuntime,
} from "../../src/agent/tool-runtime";
import type { Message } from "../../src/core";
import type { Logger, LogMetadata } from "../../src/logging";
import type { CodemodeToolContext } from "../../src/tools";
import type { Tool } from "../../src/tools/tool";

const parameters = Type.Object({});
const labeledParameters = Type.Object({
  label: Type.String(),
});

describe("ToolRuntime invocation lifecycle", () => {
  test("invokes with complete results and live events without preparing history", async () => {
    const operations: string[] = [];
    const canonicalResult = { payload: "x".repeat(128 * 1_024 + 1) };
    const content = "complete model-facing output";
    const tool = {
      name: "full_result",
      description: "Return complete data.",
      parameters: labeledParameters,
      execute: ({ label }, context) => {
        operations.push(`execute:${label}`);
        context.update("progress");
        return { content, result: canonicalResult };
      },
    } satisfies Tool<typeof labeledParameters, typeof canonicalResult>;
    const call = toolCall("call-full", tool.name);
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        beforeToolExecution: ({ toolCall: approvedCall }) => {
          operations.push("approve");
          (approvedCall.args as { label: string }).label = "changed by approval";
          return { type: "continue" };
        },
        limitToolContent: () => {
          operations.push("limit");
          return "limited";
        },
        toolResultPolicy: {
          source: "history_policy",
          finalize: () => {
            operations.push("finalize");
            return { content: "preview", persistResult: false };
          },
        },
        onMessageCommitted: () => {
          operations.push("commit");
        },
      },
      (event) => {
        operations.push(event.type);
        if (event.type === "tool_execution_end") {
          expect(event.result).toBe(canonicalResult);
        }
      },
    );

    const invoked = await runtime.invoke(call);

    expect(operations).toEqual([
      "approve",
      "tool_execution_start",
      "execute:call-full",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(invoked.toolCall).toEqual(call);
    expect(invoked.toolCall).not.toBe(call);
    expect(invoked.result.content).toBe(content);
    expect(invoked.result.result).toBe(canonicalResult);
    expect(invoked.isError).toBe(false);
    expect(invoked.abortRun ?? false).toBe(false);
  });

  test("invokes through validation and approval cancellation with the caller's signal", async () => {
    const controller = new AbortController();
    const completions: string[] = [];
    let approvalCount = 0;
    let executionCount = 0;
    let abortCount = 0;
    const tool = {
      name: "denied",
      description: "Require approval.",
      parameters: labeledParameters,
      execute: () => {
        executionCount += 1;
        return "unexpected";
      },
    } satisfies Tool<typeof labeledParameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        beforeToolExecution: ({ signal }) => {
          approvalCount += 1;
          expect(signal).toBe(controller.signal);
          return { type: "cancel", message: "Approval denied." };
        },
      },
      (event) => {
        expect(event.type).toBe("tool_execution_end");
        if (event.type === "tool_execution_end") completions.push(event.toolCallId);
      },
    );
    const options = {
      signal: controller.signal,
      onAbortRun: () => {
        abortCount += 1;
      },
    };

    const invalid = await runtime.invoke(
      { type: "tool_call", id: "invalid", name: tool.name, args: {} },
      options,
    );
    const denied = await runtime.invoke(toolCall("denied", tool.name), options);

    expect(invalid.isError).toBe(true);
    expect(invalid.result.content).toContain("label");
    expect(denied).toMatchObject({
      result: {
        content: "Approval denied.",
        result: { error: "Approval denied.", canceled: true },
        isError: true,
      },
      isError: true,
      abortRun: true,
    });
    expect(approvalCount).toBe(1);
    expect(executionCount).toBe(0);
    expect(abortCount).toBe(1);
    expect(completions).toEqual(["invalid", "denied"]);
  });

  test("serializes update events and publishes completion before committing the result", async () => {
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
      "end",
      "commit:tool",
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

  test("commits visual observations returned by tools", async () => {
    const image = {
      mimeType: "image/png" as const,
      data: "aW1hZ2U=",
      width: 32,
      height: 16,
    };
    const tool = {
      name: "view_image",
      description: "View an image.",
      parameters,
      execute: () => ({
        content: "Viewed image.png",
        images: [image],
        result: { path: "image.png" },
      }),
    } satisfies Tool<typeof parameters, { path: string }>;
    const committed: Message[] = [];
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        onMessageCommitted: (message) => {
          committed.push(message);
        },
      },
      () => {},
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "call-view", name: "view_image", args: {} },
    ]);

    expect(result.toolResults[0]).toMatchObject({
      role: "tool",
      toolCallId: "call-view",
      toolName: "view_image",
      content: "Viewed image.png",
      images: [image],
      result: { path: "image.png" },
      isError: false,
    });
    expect(committed).toEqual(result.toolResults);
  });

  test("turns malformed visual result fields into safe failures before commit", async () => {
    const tools: Tool[] = [
      {
        name: "invalid_images",
        description: "Return malformed images.",
        parameters,
        execute: () => ({
          content: "done",
          images: [{ foo: "bar" }],
          result: {},
        }),
      },
      {
        name: "invalid_is_error",
        description: "Return malformed isError.",
        parameters,
        execute: () => ({
          content: "done",
          result: {},
          isError: "yes",
        }),
      },
    ];
    const committed: Message[] = [];
    const runtime = new ToolRuntime(
      {
        tools,
        onMessageCommitted: (message) => {
          committed.push(message);
        },
      },
      () => {},
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "call-images", name: "invalid_images", args: {} },
      { type: "tool_call", id: "call-error", name: "invalid_is_error", args: {} },
    ]);

    expect(result.toolResults).toEqual([
      expect.objectContaining({
        toolCallId: "call-images",
        content:
          "Tool call failed: Tool result images must be an array of valid UserImage objects.",
        isError: true,
      }),
      expect.objectContaining({
        toolCallId: "call-error",
        content: "Tool call failed: Tool result isError must be a boolean when provided.",
        isError: true,
      }),
    ]);
    for (const message of result.toolResults) {
      expect(message).not.toHaveProperty("images");
    }
    expect(committed).toEqual(result.toolResults);
    expect(JSON.stringify(committed)).not.toContain('"foo":"bar"');
  });

  test("publishes tool completion even when the result commit fails", async () => {
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

    expect(events).toEqual(["tool_execution_start", "tool_execution_end"]);
  });
});

describe("ToolRuntime deadlines and configuration", () => {
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

  test("validates tool-result policy sources", () => {
    expect(
      () =>
        new ToolRuntime(
          {
            tools: [],
            toolResultPolicy: { source: " invalid", finalize: () => undefined },
          },
          () => {},
        ),
    ).toThrow("Tool result policy source must be a non-empty trimmed string.");
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

describe("ToolRuntime nested invocations", () => {
  test("only run_code receives the nested invocation context", async () => {
    let ordinaryCalls = 0;
    const events: AgentEvent[] = [];
    const ordinary = {
      name: "ordinary",
      description: "Use the normal tool context.",
      parameters,
      execute(_args, context) {
        expect(context).not.toHaveProperty("invokeTool");
        ordinaryCalls += 1;
        context.update("progress");
        return "ordinary result";
      },
    } satisfies Tool<typeof parameters, string>;
    const codemode = {
      name: "run_code",
      description: "Use the orchestration context.",
      parameters,
      async execute(_args, context: CodemodeToolContext) {
        expect(typeof context.invokeTool).toBe("function");
        return (await context.invokeTool("ordinary", {})).result;
      },
    } satisfies Tool;
    const runtime = new ToolRuntime({ tools: [ordinary, codemode] }, (event) => {
      events.push(event);
    });

    const result = await runtime.execute([
      { type: "tool_call", id: "ordinary", name: "ordinary", args: {} },
      { type: "tool_call", id: "code", name: "run_code", args: {} },
    ]);

    expect(ordinaryCalls).toBe(2);
    expect(result.toolResults.map((message) => message.content)).toEqual([
      "ordinary result",
      "ordinary result",
    ]);
    const executionEvents = events.filter(
      (event) =>
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end",
    );
    expect(
      executionEvents
        .filter((event) => event.parentToolCallId === "code")
        .map((event) => event.type),
    ).toEqual(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
    for (const event of executionEvents.filter(
      (event) => event.toolCallId === "ordinary" || event.toolCallId === "code",
    )) {
      expect(event).not.toHaveProperty("parentToolCallId");
    }
  });

  test.each([true, false])(
    "bounds parallel calls and preserves exclusive barriers (parallel=%s)",
    async (parallelToolCalls) => {
      const starts: string[] = [];
      const finish = new Map<string, () => void>();
      const makeTool = (name: string, concurrency: "parallel" | "exclusive") =>
        ({
          name,
          description: name,
          parameters: labeledParameters,
          execution: { concurrency },
          execute: ({ label }) =>
            new Promise<string>((resolve) => {
              starts.push(label);
              finish.set(label, () => resolve(label));
            }),
        }) satisfies Tool<typeof labeledParameters, string>;
      const outer = {
        name: "run_code",
        description: "Invoke a group of nested calls.",
        parameters,
        async execute(_args, { invokeTool }: CodemodeToolContext) {
          const calls = [
            ["parallel", "p1"],
            ["parallel", "p2"],
            ["parallel", "p3"],
            ["exclusive", "barrier"],
            ["parallel", "p4"],
          ];
          const results = await Promise.all(
            calls.map(([name, label]) => invokeTool(name!, { label })),
          );
          return results.map((result) => result.result);
        },
      } satisfies Tool<typeof parameters, unknown[]>;
      const runtime = new ToolRuntime(
        {
          tools: [outer],
          callableTools: [makeTool("parallel", "parallel"), makeTool("exclusive", "exclusive")],
          parallelToolCalls,
          maxParallelToolCalls: 2,
        },
        () => {},
      );
      const execution = runtime.execute([
        { type: "tool_call", id: "outer", name: "run_code", args: {} },
      ]);

      await waitFor(() => finish.has(parallelToolCalls ? "p2" : "p1"));
      expect(starts).toEqual(parallelToolCalls ? ["p1", "p2"] : ["p1"]);
      finish.get("p1")!();
      await waitFor(() => finish.has(parallelToolCalls ? "p3" : "p2"));
      expect(starts).toEqual(parallelToolCalls ? ["p1", "p2", "p3"] : ["p1", "p2"]);
      finish.get("p2")!();
      await waitFor(() => finish.has("p3"));
      expect(finish.has("barrier")).toBe(false);
      finish.get("p3")!();
      await waitFor(() => finish.has("barrier"));
      expect(finish.has("p4")).toBe(false);
      finish.get("barrier")!();
      await waitFor(() => finish.has("p4"));
      finish.get("p4")!();

      expect((await execution).toolResults[0]?.result).toEqual(["p1", "p2", "p3", "barrier", "p4"]);
    },
  );

  test("serializes nested approval hooks", async () => {
    const approvals: string[] = [];
    const approve: Array<() => void> = [];
    const events: AgentEvent[] = [];
    let parentSignal: AbortSignal | undefined;
    const child = {
      name: "child",
      description: "Require approval.",
      parameters: labeledParameters,
      execution: { concurrency: "parallel" },
      execute: ({ label }) => label,
    } satisfies Tool<typeof labeledParameters, string>;
    const outer = {
      name: "run_code",
      description: "Invoke two tools.",
      parameters,
      execution: { deadlineMs: 100 },
      execute: async (_args, { invokeTool, signal }: CodemodeToolContext) => {
        parentSignal = signal;
        await Promise.all([
          invokeTool("child", { label: "a" }),
          invokeTool("child", { label: "b" }),
        ]);
        return "done";
      },
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [outer, child],
        beforeToolExecution: ({ tool, args }) => {
          if (tool.name === "run_code") return { type: "continue" };
          approvals.push((args as { label: string }).label);
          return new Promise((resolve) => approve.push(() => resolve({ type: "continue" })));
        },
      },
      (event) => {
        events.push(event);
      },
    );
    const execution = runtime.execute([
      { type: "tool_call", id: "outer", name: "run_code", args: {} },
    ]);
    await waitFor(() => approve.length === 1);
    expect(approvals).toEqual(["a"]);
    await Bun.sleep(120);
    expect(parentSignal?.aborted).toBe(false);
    approve[0]!();
    await waitFor(() => approve.length === 2);
    expect(approvals).toEqual(["a", "b"]);
    expect(events.filter((event) => event.type === "tool_execution_resume")).toHaveLength(0);
    await Bun.sleep(120);
    expect(parentSignal?.aborted).toBe(false);
    approve[1]!();
    expect((await execution).abortRun).toBe(false);
    expect(
      events
        .filter(
          (
            event,
          ): event is Extract<
            AgentEvent,
            { type: "tool_execution_pause" | "tool_execution_resume" }
          > => event.type === "tool_execution_pause" || event.type === "tool_execution_resume",
        )
        .map((event) => ({ type: event.type, toolCallId: event.toolCallId, reason: event.reason })),
    ).toEqual([
      { type: "tool_execution_pause", toolCallId: "outer", reason: "approval" },
      { type: "tool_execution_resume", toolCallId: "outer", reason: "approval" },
    ]);
  });

  test("restores the remaining parent deadline after an approval longer than its budget", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const timers = spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    let startChild: (() => void) | undefined;
    let approveChild: (() => void) | undefined;
    let parentSignal: AbortSignal | undefined;
    const child = {
      name: "child",
      description: "Wait until canceled.",
      parameters,
      execution: { deadlineMs: 1_000 },
      execute: (_args, { signal }) =>
        new Promise<string>((resolve) => {
          signal!.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool<typeof parameters, string>;
    const outer = {
      name: "run_code",
      description: "Spend part of the budget before approval.",
      parameters,
      execution: { deadlineMs: 100 },
      async execute(_args, { invokeTool, signal }: CodemodeToolContext) {
        parentSignal = signal;
        await new Promise<void>((resolve) => {
          startChild = resolve;
        });
        await invokeTool("child", {});
        return "done";
      },
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [outer, child],
        signal: controller.signal,
        beforeToolExecution: ({ tool }) =>
          tool.name === "run_code"
            ? { type: "continue" }
            : new Promise((resolve) => {
                approveChild = () => resolve({ type: "continue" });
              }),
      },
      () => {},
    );
    try {
      const execution = runtime.execute([
        { type: "tool_call", id: "outer", name: "run_code", args: {} },
      ]);
      await waitFor(() => startChild !== undefined);
      now = 70;
      startChild!();
      await waitFor(() => approveChild !== undefined);
      await Bun.sleep(120);
      expect(parentSignal?.aborted).toBe(false);
      now = 10_000;
      approveChild!();
      const result = await execution;
      expect(
        timers.mock.calls.map((args) => args[1]).filter((delay) => delay === 100 || delay === 30),
      ).toEqual([100, 30]);
      expect(result.toolResults[0]).toMatchObject({
        isError: true,
        result: { status: "timed_out", deadlineMs: 100 },
      });
    } finally {
      controller.abort();
      approveChild?.();
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  test("a running child's deadline remains active while another child awaits approval", async () => {
    const events: AgentEvent[] = [];
    const running = {
      name: "running",
      description: "Reach its own deadline.",
      parameters,
      execution: { concurrency: "parallel", deadlineMs: 30 },
      execute: (_args, { signal }) =>
        new Promise<string>((resolve) => {
          signal!.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool<typeof parameters, string>;
    const waiting = {
      name: "waiting",
      description: "Remain in approval.",
      parameters,
      execution: { concurrency: "parallel" },
      execute: () => "unexpected",
    } satisfies Tool<typeof parameters, string>;
    const outer = {
      name: "run_code",
      description: "Run a tool while another needs approval.",
      parameters,
      execute: async (_args, { invokeTool }: CodemodeToolContext) => {
        await Promise.all([invokeTool("running", {}), invokeTool("waiting", {})]);
        return "done";
      },
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [outer, running, waiting],
        beforeToolExecution: ({ tool, signal }) =>
          tool.name !== "waiting"
            ? { type: "continue" }
            : new Promise((resolve) =>
                signal!.addEventListener("abort", () => resolve({ type: "cancel" }), {
                  once: true,
                }),
              ),
      },
      (event) => {
        events.push(event);
      },
    );
    const result = await runtime.execute([
      { type: "tool_call", id: "outer", name: "run_code", args: {} },
    ]);
    expect(result.abortRun).toBe(true);
    expect(result.toolResults[0]).toMatchObject({ isError: true, result: { status: "canceled" } });
    expect(
      events.find((event) => event.type === "tool_execution_end" && event.toolName === "running"),
    ).toMatchObject({
      result: { status: "timed_out", deadlineMs: 30 },
    });
    expect(events.filter((event) => event.type === "tool_execution_pause")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_resume")).toHaveLength(0);
  });

  test("canceling a child signal does not abort its parent", async () => {
    const childController = new AbortController();
    let started = false;
    const child = {
      name: "child",
      description: "Wait for cancellation.",
      parameters,
      async execute(_args, { signal }) {
        started = true;
        await new Promise((resolve) => signal!.addEventListener("abort", resolve, { once: true }));
        return "stopped";
      },
    } satisfies Tool<typeof parameters, string>;
    const outer = {
      name: "run_code",
      description: "Cancel a nested call.",
      parameters,
      async execute(_args, { invokeTool }: CodemodeToolContext) {
        const pending = invokeTool("child", {}, { signal: childController.signal });
        await waitFor(() => started);
        childController.abort();
        expect((await pending).isError).toBe(true);
        return "done";
      },
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime({ tools: [outer, child] }, () => {});
    const result = await runtime.execute([
      { type: "tool_call", id: "outer", name: "run_code", args: {} },
    ]);
    expect(result.abortRun).toBe(false);
    expect(result.toolResults[0]).toMatchObject({ content: "done", isError: false });
  });

  test("a nested deadline interrupts the parent and cancels queued calls", async () => {
    let laterCount = 0;
    const child = {
      name: "child",
      description: "Exceed a deadline.",
      parameters,
      execution: { deadlineMs: 5 },
      execute: (_args, { signal }) =>
        new Promise<string>((resolve) => {
          signal!.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool<typeof parameters, string>;
    const later = {
      name: "later",
      description: "Stay queued.",
      parameters,
      execute: () => {
        laterCount += 1;
        return "unexpected";
      },
    } satisfies Tool<typeof parameters, string>;
    const outer = {
      name: "run_code",
      description: "Invoke two tools.",
      parameters,
      execute: async (_args, { invokeTool }: CodemodeToolContext) => {
        await Promise.all([invokeTool("child", {}), invokeTool("later", {})]);
        return "finished";
      },
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime({ tools: [outer, child, later] }, () => {});
    const result = await runtime.execute([
      { type: "tool_call", id: "outer", name: "run_code", args: {} },
    ]);
    expect(result.abortRun).toBe(true);
    expect(result.toolResults[0]).toMatchObject({ isError: true, result: { status: "canceled" } });
    expect(laterCount).toBe(0);
  });
});

describe("ToolRuntime parallel scheduling", () => {
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
});

describe("ToolRuntime result finalization and policy", () => {
  test("finalizes every normalized result exactly once", async () => {
    const finalized: Array<{ name: string; isError: boolean }> = [];
    const success = {
      name: "success",
      description: "Succeed.",
      parameters: labeledParameters,
      execute: ({ label }) => label,
    } satisfies Tool<typeof labeledParameters, string>;
    const failure = {
      name: "failure",
      description: "Throw.",
      parameters: labeledParameters,
      execute: () => {
        throw new Error("execution failed");
      },
    } satisfies Tool<typeof labeledParameters, string>;
    const denied = {
      name: "denied",
      description: "Require approval.",
      parameters: labeledParameters,
      execute: () => "unexpected",
    } satisfies Tool<typeof labeledParameters, string>;
    const handled = {
      name: "handled",
      description: "Return from the hook.",
      parameters: labeledParameters,
      execute: () => {
        throw new Error("hook result should skip execution");
      },
    } satisfies Tool<typeof labeledParameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [success, failure, denied, handled],
        beforeToolExecution: ({ tool }) => {
          if (tool.name === "denied") {
            return { type: "cancel", abortRun: false, message: "Approval denied." };
          }
          if (tool.name === "handled") {
            return {
              type: "return",
              result: { content: "Handled before execution.", result: { handled: true } },
            };
          }
          return { type: "continue" };
        },
        toolResultPolicy: {
          source: "recording",
          finalize: ({ toolCall, isError }) => {
            finalized.push({ name: toolCall.name, isError });
          },
        },
      },
      () => {},
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "success", name: "success", args: { label: "ok" } },
      { type: "tool_call", id: "invalid", name: "success", args: {} },
      { type: "tool_call", id: "missing", name: "missing", args: {} },
      { type: "tool_call", id: "failure", name: "failure", args: { label: "bad" } },
      { type: "tool_call", id: "denied", name: "denied", args: { label: "no" } },
      { type: "tool_call", id: "handled", name: "handled", args: { label: "skip" } },
    ]);

    expect(finalized).toEqual([
      { name: "success", isError: false },
      { name: "success", isError: true },
      { name: "missing", isError: true },
      { name: "failure", isError: true },
      { name: "denied", isError: true },
      { name: "handled", isError: false },
    ]);
    expect(result.toolResults).toHaveLength(6);
    expect(result.toolResults[5]).toMatchObject({
      content: "Handled before execution.",
      result: { handled: true },
      isError: false,
    });
    expect(result.abortRun).toBe(false);
  });

  test("finalizes calls canceled before execution", async () => {
    const controller = new AbortController();
    const finalized: string[] = [];
    controller.abort();
    const runtime = new ToolRuntime(
      {
        signal: controller.signal,
        toolResultPolicy: {
          source: "recording",
          finalize: ({ toolCall }) => {
            finalized.push(toolCall.id);
          },
        },
      },
      () => {},
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "canceled", name: "unused", args: {} },
    ]);

    expect(finalized).toEqual(["canceled"]);
    expect(result.toolResults[0]).toMatchObject({ isError: true });
  });

  test("commits policy context after sibling results and keeps structured results intact", async () => {
    const commits: Message[] = [];
    const tool = {
      name: "parallel",
      description: "Return a labeled result.",
      parameters: labeledParameters,
      execution: { concurrency: "parallel" },
      execute: ({ label }) => ({
        content: `original:${label}`,
        result: { label },
      }),
    } satisfies Tool<typeof labeledParameters, { label: string }>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        toolResultPolicy: {
          source: "test_policy",
          finalize: ({ toolCall }) => ({
            content: `replacement:${toolCall.id}`,
            additionalContext: [`context:${toolCall.id}`],
          }),
        },
        onMessageCommitted: (message) => {
          commits.push(message);
        },
      },
      () => {},
    );

    const result = await runtime.execute([toolCall("p1", "parallel"), toolCall("p2", "parallel")]);

    expect(commits.map((message) => message.role)).toEqual(["tool", "tool", "user", "user"]);
    expect(result.toolResults).toEqual([
      expect.objectContaining({
        toolCallId: "p1",
        content: "replacement:p1",
        result: { label: "p1" },
      }),
      expect.objectContaining({
        toolCallId: "p2",
        content: "replacement:p2",
        result: { label: "p2" },
      }),
    ]);
    expect(result.additionalMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "context:p1",
        provenance: { kind: "tool_result_policy", source: "test_policy" },
      }),
      expect.objectContaining({
        role: "user",
        content: "context:p2",
        provenance: { kind: "tool_result_policy", source: "test_policy" },
      }),
    ]);
  });

  test("keeps canonical results live and durable when content is stored as an artifact", async () => {
    const canonicalResult = { payload: "large structured result" };
    const locator = "/tmp/kana-artifact.txt";
    let executionEndResult: unknown;
    const tool = {
      name: "large",
      description: "Return a large result.",
      parameters,
      execute: () => ({
        content: "large model-facing output",
        result: canonicalResult,
      }),
    } satisfies Tool<typeof parameters, typeof canonicalResult>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        toolContentByteLimit: 768,
        toolResultPolicy: {
          source: "artifact_policy",
          finalize: (input) => {
            expect(input.resultByteLength).toBe(
              Buffer.byteLength(JSON.stringify(canonicalResult), "utf8"),
            );
            expect(input.contentByteLimit).toBe(768);
            return {
              content: "bounded preview",
              artifact: { kind: "text", locator, byteLength: 10_000 },
            };
          },
        },
      },
      (event) => {
        if (event.type === "tool_execution_end") {
          executionEndResult = event.result;
        }
      },
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "call-1", name: "large", args: {} },
    ]);

    expect(executionEndResult).toBe(canonicalResult);
    expect(result.toolResults[0]).toMatchObject({
      content: "bounded preview",
      artifact: { kind: "text", locator, byteLength: 10_000 },
      result: canonicalResult,
    });
  });

  test.each([128 * 1_024 - 1, 128 * 1_024, 128 * 1_024 + 1])(
    "bounds persisted results at 128 KiB without changing live data (%i serialized bytes)",
    async (byteLength) => {
      const payloadBytes = byteLength - Buffer.byteLength(JSON.stringify({ payload: "" }), "utf8");
      const canonicalResult = {
        payload: "中".repeat(Math.floor(payloadBytes / 3)) + "x".repeat(payloadBytes % 3),
      };
      const committed: Message[] = [];
      let executionEndResult: unknown;
      const tool = {
        name: "large_result",
        description: "Return structured data with short content.",
        parameters,
        execute: () => ({ content: "short output", result: canonicalResult }),
      } satisfies Tool<typeof parameters, typeof canonicalResult>;
      const runtime = new ToolRuntime(
        {
          tools: [tool],
          toolContentByteLimit: 32,
          onMessageCommitted: (message) => {
            committed.push(message);
          },
        },
        (event) => {
          if (event.type === "tool_execution_end") executionEndResult = event.result;
        },
      );

      const result = await runtime.execute([
        { type: "tool_call", id: "call-large", name: "large_result", args: {} },
      ]);

      expect(Buffer.byteLength(JSON.stringify(canonicalResult), "utf8")).toBe(byteLength);
      expect(executionEndResult).toBe(canonicalResult);
      expect(result.toolResults[0]).toMatchObject({ content: "short output", isError: false });
      expect(committed).toEqual(result.toolResults);
      if (byteLength <= 128 * 1_024) {
        expect(result.toolResults[0]?.result).toEqual(canonicalResult);
      } else {
        expect(result.toolResults[0]).not.toHaveProperty("result");
      }
    },
  );

  test("detaches validated policy output from getters before leaving containment", async () => {
    let contentReads = 0;
    const tool = {
      name: "safe",
      description: "Return original content.",
      parameters,
      execute: () => "original content",
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        toolResultPolicy: {
          source: "getter_policy",
          finalize: () => {
            const output = {};
            Object.defineProperty(output, "content", {
              enumerable: true,
              get() {
                contentReads += 1;
                if (contentReads > 2) {
                  throw new Error("content read outside containment");
                }
                return "replacement content";
              },
            });
            return output;
          },
        },
      },
      () => {},
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "call-1", name: "safe", args: {} },
    ]);

    expect(contentReads).toBe(1);
    expect(result.toolResults[0]?.content).toBe("replacement content");
  });

  test("rejects sparse policy context and falls back to the original result", async () => {
    const logs: Array<{ event: string; metadata?: LogMetadata }> = [];
    const tool = {
      name: "safe",
      description: "Return original content.",
      parameters,
      execute: () => "original content",
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        toolResultPolicy: {
          source: "sparse_policy",
          finalize: () => ({ additionalContext: new Array<string>(1) }),
        },
        logger: createRecordingLogger(logs),
      },
      () => {},
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "call-1", name: "safe", args: {} },
    ]);

    expect(result.toolResults[0]?.content).toBe("original content");
    expect(result.additionalMessages).toEqual([]);
    expect(logs).toEqual([
      {
        event: "tool.result_policy_failed",
        metadata: {
          policySource: "sparse_policy",
          toolName: "safe",
          errorType: "Error",
        },
      },
    ]);
  });

  test("finalizes outcomes whose structured result cannot be cloned", async () => {
    const structuredResult = new WeakMap<object, string>();
    structuredResult.set({}, "host-only value");
    let policyInput: ToolResultPolicyInput | undefined;
    const tool = {
      name: "non_cloneable",
      description: "Return host-only structured data.",
      parameters,
      execute: () => ({
        content: "original content",
        result: structuredResult,
      }),
    } satisfies Tool<typeof parameters, WeakMap<object, string>>;
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        toolResultPolicy: {
          source: "content_only_policy",
          finalize: (input) => {
            policyInput = input;
            return { content: `policy saw: ${input.content}` };
          },
        },
      },
      () => {},
    );

    const result = await runtime.execute([
      { type: "tool_call", id: "call-1", name: "non_cloneable", args: {} },
    ]);

    expect(policyInput).toEqual({
      toolCall: { type: "tool_call", id: "call-1", name: "non_cloneable", args: {} },
      content: "original content",
      isError: false,
      resultByteLength: undefined,
      contentByteLimit: undefined,
    });
    expect(result.toolResults[0]?.content).toBe("policy saw: original content");
    expect(result.toolResults[0]).not.toHaveProperty("result");
  });

  test("contains policy failures and protects the model-authored call and result", async () => {
    const logs: Array<{ event: string; metadata?: LogMetadata }> = [];
    const calls = [
      {
        type: "tool_call" as const,
        id: "call-1",
        name: "safe",
        args: { value: "secret argument" },
      },
    ];
    const tool = {
      name: "safe",
      description: "Return an original result.",
      parameters: Type.Object({ value: Type.String() }),
      execute: () => ({
        content: "original content",
        result: { value: "original structured result" },
      }),
    } satisfies Tool;
    const policy: ToolResultPolicy = {
      source: "failing_policy",
      finalize: (input) => {
        const mutableInput = input as {
          toolCall: { name: string; args: { value: string } };
          content: string;
        };
        mutableInput.toolCall.name = "mutated";
        mutableInput.toolCall.args.value = "mutated";
        mutableInput.content = "mutated";
        throw new Error("secret policy failure");
      },
    };
    const runtime = new ToolRuntime(
      {
        tools: [tool],
        toolResultPolicy: policy,
        logger: createRecordingLogger(logs),
      },
      () => {},
    );

    const result = await runtime.execute(calls);

    expect(calls[0]).toEqual({
      type: "tool_call",
      id: "call-1",
      name: "safe",
      args: { value: "secret argument" },
    });
    expect(result.toolResults[0]).toMatchObject({
      toolName: "safe",
      content: "original content",
      result: { value: "original structured result" },
    });
    expect(logs).toEqual([
      {
        event: "tool.result_policy_failed",
        metadata: {
          policySource: "failing_policy",
          toolName: "safe",
          errorType: "Error",
        },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });
});

describe("ToolRuntime parallel failure containment", () => {
  test("stops replenishing immediately and cancels siblings when one invocation reaches deadline", async () => {
    const starts: string[] = [];
    const deadlineTool = {
      name: "deadline",
      description: "Reach a deadline without honoring cancellation.",
      parameters,
      execution: {
        concurrency: "parallel",
        deadlineMs: 5,
      },
      execute: () => {
        starts.push("deadline");
        return new Promise(() => {});
      },
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
          starts.push(context.toolCallId);
          context.signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
        }),
    } satisfies Tool<typeof parameters, string>;
    const runtime = new ToolRuntime(
      {
        tools: [deadlineTool, siblingTool],
        cancellationGraceMs: 10,
        maxParallelToolCalls: 2,
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
      {
        type: "tool_call",
        id: "queued-1",
        name: "sibling",
        args: {},
      },
      {
        type: "tool_call",
        id: "queued-2",
        name: "sibling",
        args: {},
      },
    ]);

    expect(starts).toEqual(["deadline", "sibling"]);
    expect(result.abortRun).toBe(true);
    expect(result.toolResults.map((message) => message.toolCallId)).toEqual([
      "deadline",
      "sibling",
      "queued-1",
      "queued-2",
    ]);
    expect(result.toolResults[0]).toMatchObject({
      result: {
        status: "unknown",
        reason: "deadline",
      },
    });
    expect(result.toolResults[1]).toMatchObject({
      result: {
        status: "canceled",
        reason: "run_aborted",
      },
    });
    expect(result.toolResults.slice(2)).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ canceled: true }) }),
      expect.objectContaining({ result: expect.objectContaining({ canceled: true }) }),
    ]);
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
