import { describe, expect, spyOn, test } from "bun:test";
import { Type } from "typebox";
import { Agent, type AgentConfig } from "../../src/agent";
import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  type Model,
  type ModelContext,
} from "../../src/core";
import {
  type HeadlessOutputStream,
  parseHeadlessTimeout,
  resolveHeadlessPrompt,
  runHeadlessConversation,
  startHeadless,
} from "../../src/headless";
import {
  ConversationRuntime,
  type ConversationRuntimeOptions,
  DEFAULT_KANA_TOOL_APPROVALS,
} from "../../src/kana";
import { createUpdateGoalTool } from "../../src/kana/tools";
import type { Logger } from "../../src/logging";
import { MockModel } from "../../src/providers/mock";
import type { Tool } from "../../src/tools";
import { messageIdentityForTest } from "../helpers/messages";

describe("headless execution", () => {
  test("writes only the final answer to human stdout", async () => {
    const stdout = new StringOutput();
    const stderr = new StringOutput();
    const runtime = createRuntime({
      model: new MockModel({
        provider: "mock",
        model: "mock",
        response: "Complete.",
      }),
    });

    const result = await runHeadlessConversation({
      runtime,
      prompt: "Run the task.",
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      stdout,
      stderr,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      outcome: "stop",
      finalMessage: "Complete.",
    });
    expect(stdout.value).toBe("Complete.\n");
    expect(stderr.value).toContain("Session: session-1");
    expect(stderr.value).toContain("Running...");
    await runtime.close();
  });

  test("emits a versioned public JSONL protocol instead of internal Agent events", async () => {
    const stdout = new StringOutput();
    const runtime = createRuntime({
      model: new MockModel({
        provider: "mock",
        model: "mock",
        response: "JSON answer.",
      }),
    });

    const result = await runHeadlessConversation({
      runtime,
      prompt: "Run the task.",
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      json: true,
      stdout,
      stderr: new StringOutput(),
    });
    const events = stdout.lines().map((line) => JSON.parse(line));

    expect(result.exitCode).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "run.started",
      "model_turn.started",
      "assistant.delta",
      "assistant.completed",
      "model_turn.completed",
      "run.completed",
    ]);
    expect(events.every((event) => event.schema_version === 2)).toBe(true);
    expect(events.find((event) => event.type === "assistant.completed")).toMatchObject({
      text: "JSON answer.",
    });
    expect(stdout.value).not.toContain('"type":"agent_event"');
    await runtime.close();
  });

  for (const goalCase of [
    { status: "completed" as const, exitCode: 0 },
    { status: "blocked" as const, exitCode: 1 },
  ]) {
    test(`waits for an explicitly ${goalCase.status} Goal before completing`, async () => {
      const stdout = new StringOutput();
      const runtime = createRuntime({
        model: new ToolThenAnswerModel(
          "update_goal",
          { status: goalCase.status, detail: `Goal ${goalCase.status}.` },
          "Goal report.",
        ),
        goalTool: true,
      });

      const result = await runHeadlessConversation({
        runtime,
        prompt: "Finish the task.",
        goal: true,
        approvalConfig: { mode: "unless_trusted" },
        toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
        json: true,
        stdout,
        stderr: new StringOutput(),
      });
      const events = stdout.lines().map((line) => JSON.parse(line));
      const terminalEvent = events.at(-1);

      expect(result).toMatchObject({
        exitCode: goalCase.exitCode,
        outcome: "stop",
        finalMessage: "Goal report.",
        goal: {
          status: goalCase.status,
          admittedRounds: 1,
          detail: `Goal ${goalCase.status}.`,
        },
      });
      expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
      expect(terminalEvent).toMatchObject({
        schema_version: 2,
        type: "run.completed",
        outcome: "stop",
        goal: {
          status: goalCase.status,
          admitted_rounds: 1,
          max_rounds: 8,
          detail: `Goal ${goalCase.status}.`,
        },
      });
      await runtime.close();
    });
  }

  test("projects a multi-round Goal as one bounded headless run", async () => {
    const stdout = new StringOutput();
    const runtime = createRuntime({
      model: new MockModel({
        provider: "mock",
        model: "mock",
        response: "Still working.",
      }),
      goalMaxRounds: 2,
    });

    const result = await runHeadlessConversation({
      runtime,
      prompt: "Finish the task.",
      goal: true,
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      json: true,
      stdout,
      stderr: new StringOutput(),
    });
    const events = stdout.lines().map((line) => JSON.parse(line));

    expect(result).toMatchObject({
      exitCode: 1,
      outcome: "stop",
      finalMessage: "Still working.",
      goal: {
        status: "round_limit",
        admittedRounds: 2,
        maxRounds: 2,
      },
    });
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "assistant.completed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      schema_version: 2,
      type: "run.completed",
      outcome: "stop",
      goal: {
        status: "round_limit",
        admitted_rounds: 2,
        max_rounds: 2,
        detail: "The goal reached its round limit.",
      },
    });
    await runtime.close();
  });

  test("keeps the headless timeout active across Goal rounds", async () => {
    let toolAborted = false;
    const tool: Tool = {
      name: "wait_for_abort",
      description: "Wait for cancellation.",
      parameters: Type.Object({}),
      execute: (_args, context) =>
        new Promise((resolve) => {
          const finish = (): void => {
            toolAborted = true;
            resolve({ content: "stopped", result: { stopped: true } });
          };
          if (context.signal?.aborted) {
            finish();
            return;
          }
          context.signal?.addEventListener("abort", finish, { once: true });
        }),
    };
    const runtime = createRuntime({
      model: new ScriptedModel([
        { type: "text", text: "Continue." },
        { type: "tool", name: "wait_for_abort", args: {} },
      ]),
      tools: [tool],
      goalMaxRounds: 3,
    });
    const stdout = new StringOutput();

    const result = await runHeadlessConversation({
      runtime,
      prompt: "Finish the task.",
      goal: true,
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      allowAllTools: true,
      timeoutMs: 20,
      json: true,
      stdout,
      stderr: new StringOutput(),
    });
    const events = stdout.lines().map((line) => JSON.parse(line));

    expect(result).toMatchObject({
      exitCode: 124,
      outcome: "aborted",
      termination: { reason: "timeout", timeoutMs: 20 },
      goal: { status: "cancelled", admittedRounds: 2 },
    });
    expect(toolAborted).toBe(true);
    expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      schema_version: 2,
      type: "run.completed",
      outcome: "aborted",
      termination: { reason: "timeout", timeout_ms: 20 },
      goal: { status: "cancelled", admitted_rounds: 2, max_rounds: 3 },
    });
    await runtime.close();
  });

  test("completes normally before an Agent-run timeout", async () => {
    const stdout = new StringOutput();
    const runtime = createRuntime({
      model: new MockModel({
        provider: "mock",
        model: "mock",
        response: "On time.",
      }),
    });

    const result = await runHeadlessConversation({
      runtime,
      prompt: "Run the task.",
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      timeoutMs: 1_000,
      json: true,
      stdout,
      stderr: new StringOutput(),
    });
    const terminalEvent = stdout
      .lines()
      .map((line) => JSON.parse(line))
      .at(-1);

    expect(result).toMatchObject({
      exitCode: 0,
      outcome: "stop",
      finalMessage: "On time.",
    });
    expect(result.termination).toBeUndefined();
    expect(terminalEvent).toEqual({
      schema_version: 2,
      type: "run.completed",
      outcome: "stop",
    });
    await runtime.close();
  });

  test("gracefully aborts an active tool when the Agent-run timeout elapses", async () => {
    let toolAborted = false;
    const tool: Tool = {
      name: "change_state",
      description: "Wait until the run is canceled.",
      parameters: Type.Object({}),
      execute: (_args, context) =>
        new Promise((resolve) => {
          const finish = (): void => {
            toolAborted = true;
            resolve({ content: "stopped", result: { stopped: true } });
          };
          if (context.signal?.aborted) {
            finish();
            return;
          }
          context.signal?.addEventListener("abort", finish, { once: true });
        }),
    };
    const runtime = createRuntime({
      model: new ToolThenAnswerModel(),
      tools: [tool],
    });
    const stdout = new StringOutput();
    const logs: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (event, metadata) => {
        logs.push({ event, metadata });
      },
      error: () => {},
    };

    const result = await runHeadlessConversation({
      runtime,
      prompt: "Change it.",
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      allowAllTools: true,
      timeoutMs: 20,
      logger,
      json: true,
      stdout,
      stderr: new StringOutput(),
    });
    const events = stdout.lines().map((line) => JSON.parse(line));
    const eventTypes = events.map((event) => event.type);

    expect(result).toMatchObject({
      exitCode: 124,
      outcome: "aborted",
      termination: { reason: "timeout", timeoutMs: 20 },
    });
    expect(toolAborted).toBe(true);
    expect(eventTypes.indexOf("tool.completed")).toBeLessThan(eventTypes.indexOf("run.completed"));
    expect(events.at(-1)).toEqual({
      schema_version: 2,
      type: "run.completed",
      outcome: "aborted",
      termination: { reason: "timeout", timeout_ms: 20 },
    });
    expect(logs).toEqual([
      {
        event: "headless.timeout_elapsed",
        metadata: { phase: "run", timeoutMs: 20 },
      },
    ]);
    expect(runtime.isRunning).toBe(false);
    await runtime.close();
  });

  test("parses bounded timeout durations and rejects invalid values", () => {
    expect(parseHeadlessTimeout("500ms")).toBe(500);
    expect(parseHeadlessTimeout("30s")).toBe(30_000);
    expect(parseHeadlessTimeout("30m")).toBe(1_800_000);
    expect(parseHeadlessTimeout("2h")).toBe(7_200_000);
    expect(() => parseHeadlessTimeout("0s")).toThrow("between 1ms");
    expect(() => parseHeadlessTimeout("30")).toThrow("duration such as");
    expect(() => parseHeadlessTimeout("597h")).toThrow("between 1ms");
  });

  test("fails closed when a tool needs approval and can explicitly allow it", async () => {
    let executions = 0;
    const tool: Tool = {
      name: "change_state",
      description: "Change state.",
      parameters: Type.Object({}),
      execute: () => {
        executions += 1;
        return { content: "changed", result: { changed: true } };
      },
    };
    const deniedRuntime = createRuntime({
      model: new ToolThenAnswerModel(),
      tools: [tool],
    });
    const deniedError = new StringOutput();

    const denied = await runHeadlessConversation({
      runtime: deniedRuntime,
      prompt: "Change it.",
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      stderr: deniedError,
      stdout: new StringOutput(),
    });

    expect(denied).toMatchObject({ exitCode: 1, outcome: "aborted" });
    expect(deniedError.value).toContain("--allow-all-tools");
    expect(executions).toBe(0);
    await deniedRuntime.close();

    const allowedRuntime = createRuntime({
      model: new ToolThenAnswerModel(),
      tools: [tool],
    });
    const allowedOutput = new StringOutput();
    const allowed = await runHeadlessConversation({
      runtime: allowedRuntime,
      prompt: "Change it.",
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      allowAllTools: true,
      json: true,
      stderr: new StringOutput(),
      stdout: allowedOutput,
    });

    expect(allowed).toMatchObject({
      exitCode: 0,
      outcome: "stop",
      finalMessage: "Finished.",
    });
    expect(executions).toBe(1);
    expect(
      allowedOutput
        .lines()
        .map((line) => JSON.parse(line))
        .filter((event) => event.type.startsWith("tool.")),
    ).toEqual([
      {
        schema_version: 2,
        type: "tool.started",
        tool_call_id: "call-1",
        name: "change_state",
        arguments: {},
      },
      {
        schema_version: 2,
        type: "tool.completed",
        tool_call_id: "call-1",
        name: "change_state",
        result: { changed: true },
        is_error: false,
      },
    ]);
    await allowedRuntime.close();
  });

  test("reports physical tool completion before a later journal failure", async () => {
    const commitError = new Error("journal unavailable");
    const tool: Tool = {
      name: "change_state",
      description: "Change state.",
      parameters: Type.Object({}),
      execute: () => ({ content: "changed", result: { changed: true } }),
    };
    const runtime = createRuntime({
      model: new ToolThenAnswerModel(),
      tools: [tool],
      journal: {
        startRun: () => {},
        appendMessage: ({ message }) => {
          if (message.role === "tool") {
            throw commitError;
          }
        },
        appendCompaction: () => {},
        endRun: () => {},
      },
    });
    const stdout = new StringOutput();

    const result = await runHeadlessConversation({
      runtime,
      prompt: "Change it.",
      approvalConfig: { mode: "unless_trusted" },
      toolApprovals: DEFAULT_KANA_TOOL_APPROVALS,
      allowAllTools: true,
      json: true,
      stderr: new StringOutput(),
      stdout,
    });
    const events = stdout.lines().map((line) => JSON.parse(line));
    const eventTypes = events.map((event) => event.type);

    expect(result.exitCode).toBe(1);
    expect(eventTypes.indexOf("tool.completed")).toBeLessThan(eventTypes.indexOf("run.failed"));
    expect(eventTypes).not.toContain("run.completed");
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      schema_version: 2,
      result: { changed: true },
      is_error: false,
    });
    expect(events.find((event) => event.type === "run.failed")).toMatchObject({
      schema_version: 2,
      error: { message: "journal unavailable" },
    });
    await runtime.close();
  });

  test("reads a missing prompt from stdin and rejects empty interactive input", async () => {
    expect(await resolveHeadlessPrompt(undefined, chunks(["from ", "stdin\n"]))).toBe("from stdin");
    await expect(resolveHeadlessPrompt(undefined, chunks([], { isTTY: true }))).rejects.toThrow(
      "prompt argument",
    );
  });

  test("reads a regular file redirected to the default stdin", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'import "node:process"; import { resolveHeadlessPrompt } from "./src/headless"; process.stdout.write(await resolveHeadlessPrompt(undefined));',
      ],
      {
        stdin: Bun.file("package.json"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe((await Bun.file("package.json").text()).trim());
  });

  test("rejects resuming a saved session in clean mode using the JSON protocol", async () => {
    const writes: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      expect(
        await startHeadless({
          prompt: "Continue.",
          resumeSessionId: "saved-session",
          launchMode: "clean",
          json: true,
        }),
      ).toBe(1);
      expect(JSON.parse(writes.join("").trim())).toMatchObject({
        schema_version: 2,
        type: "error",
        phase: "startup",
        error: {
          message: "Clean mode cannot resume saved sessions because its session is temporary.",
        },
      });
    } finally {
      write.mockRestore();
    }
  });
});

class StringOutput implements HeadlessOutputStream {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }

  lines(): string[] {
    return this.value.trim().split("\n").filter(Boolean);
  }
}

type ScriptedModelResponse =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> };

class ScriptedModel extends BaseModel {
  readonly metadata = new MockModel({ provider: "mock", model: "mock" }).metadata;
  private invocation = 0;

  constructor(private readonly responses: readonly ScriptedModelResponse[]) {
    super();
  }

  stream(_context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();
    const response = this.responses[this.invocation];
    this.invocation += 1;

    queueMicrotask(() => {
      if (!response) {
        stream.error({
          type: "error",
          reason: "error",
          error: new Error("Scripted model ran out of responses."),
          snapshot: { ...messageIdentityForTest("assistant"), role: "assistant", content: [] },
        });
        return;
      }
      if (response.type === "tool") {
        const toolCall = {
          type: "tool_call" as const,
          id: "call-1",
          name: response.name,
          args: response.args,
        };
        const message: AssistantMessage = {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          stopReason: "toolUse",
          content: [toolCall],
        };
        stream.push({
          type: "start",
          snapshot: { ...messageIdentityForTest("assistant"), role: "assistant", content: [] },
        });
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          snapshot: { ...messageIdentityForTest("assistant"), role: "assistant", content: [] },
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall,
          snapshot: message,
        });
        stream.end({ type: "done", reason: "toolUse", message });
        return;
      }

      const message: AssistantMessage = {
        ...messageIdentityForTest("assistant"),
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: response.text }],
      };
      stream.push({
        type: "start",
        snapshot: { ...messageIdentityForTest("assistant"), role: "assistant", content: [] },
      });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        snapshot: {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [{ type: "text", text: "" }],
        },
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: response.text,
        snapshot: message,
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: response.text,
        snapshot: message,
      });
      stream.end({ type: "done", reason: "stop", message });
    });

    return stream;
  }
}

class ToolThenAnswerModel extends ScriptedModel {
  constructor(
    toolName = "change_state",
    toolArgs: Record<string, unknown> = {},
    answer = "Finished.",
  ) {
    super([
      { type: "tool", name: toolName, args: toolArgs },
      { type: "text", text: answer },
    ]);
  }
}

function createRuntime(options: {
  model: Model;
  tools?: Tool[];
  journal?: AgentConfig["journal"];
  goalTool?: boolean;
  goalMaxRounds?: number;
}): ConversationRuntime {
  const runtimeOptions: ConversationRuntimeOptions<never> = {
    initialSession: {
      id: "session-1",
      messages: [],
      timeline: [],
    },
    createAgent: (agentOptions) =>
      new Agent({
        model: options.model,
        tools: [
          ...(options.tools ?? []),
          ...(options.goalTool ? [createUpdateGoalTool({ update: agentOptions.updateGoal })] : []),
        ],
        messages: agentOptions.messages,
        beforeToolExecution: agentOptions.beforeToolExecution,
        journal: options.journal,
      }),
    createNewSession: () => ({ id: "session-new" }),
    forkSession: () => ({ id: "session-fork" }),
    loadSession: (sessionId) => ({
      id: sessionId,
      messages: [],
      timeline: [],
    }),
    goalMaxRounds: options.goalMaxRounds,
    scheduledRuns: false,
  };
  return new ConversationRuntime(runtimeOptions);
}

function chunks(
  values: string[],
  options: { isTTY?: boolean } = {},
): AsyncIterable<unknown> & { isTTY?: boolean } {
  return {
    ...options,
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}
