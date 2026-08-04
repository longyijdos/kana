import { describe, expect, spyOn, test } from "bun:test";
import { Type } from "typebox";
import { Agent } from "../../src/agent";
import {
  AssistantEventStream,
  type AssistantMessage,
  BaseModel,
  type Model,
  type ModelContext,
} from "../../src/core";
import {
  type HeadlessOutputStream,
  resolveHeadlessPrompt,
  runHeadlessConversation,
  startHeadless,
} from "../../src/headless";
import {
  ConversationRuntime,
  type ConversationRuntimeOptions,
  DEFAULT_KANA_TOOL_APPROVALS,
} from "../../src/kana";
import { MockModel } from "../../src/providers/mock";
import type { Tool } from "../../src/tools";

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
    expect(events.every((event) => event.schema_version === 1)).toBe(true);
    expect(events.find((event) => event.type === "assistant.completed")).toMatchObject({
      text: "JSON answer.",
    });
    expect(stdout.value).not.toContain('"type":"agent_event"');
    await runtime.close();
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
        schema_version: 1,
        type: "tool.started",
        tool_call_id: "call-1",
        name: "change_state",
        arguments: {},
      },
      {
        schema_version: 1,
        type: "tool.completed",
        tool_call_id: "call-1",
        name: "change_state",
        result: { changed: true },
        is_error: false,
      },
    ]);
    await allowedRuntime.close();
  });

  test("reads a missing prompt from stdin and rejects empty interactive input", async () => {
    expect(await resolveHeadlessPrompt(undefined, chunks(["from ", "stdin\n"]))).toBe("from stdin");
    await expect(resolveHeadlessPrompt(undefined, chunks([], { isTTY: true }))).rejects.toThrow(
      "prompt argument",
    );
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
        schema_version: 1,
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

class ToolThenAnswerModel extends BaseModel {
  readonly metadata = new MockModel({ provider: "mock", model: "mock" }).metadata;
  private invocation = 0;

  stream(_context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();
    const invocation = this.invocation;
    this.invocation += 1;

    queueMicrotask(() => {
      if (invocation === 0) {
        const toolCall = {
          type: "tool_call" as const,
          id: "call-1",
          name: "change_state",
          args: {},
        };
        const message: AssistantMessage = {
          role: "assistant",
          stopReason: "toolUse",
          content: [toolCall],
        };
        stream.push({ type: "start", snapshot: { role: "assistant", content: [] } });
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          snapshot: { role: "assistant", content: [] },
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
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Finished." }],
      };
      stream.push({ type: "start", snapshot: { role: "assistant", content: [] } });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        snapshot: { role: "assistant", content: [{ type: "text", text: "" }] },
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "Finished.",
        snapshot: message,
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: "Finished.",
        snapshot: message,
      });
      stream.end({ type: "done", reason: "stop", message });
    });

    return stream;
  }
}

function createRuntime(options: { model: Model; tools?: Tool[] }): ConversationRuntime {
  const runtimeOptions: ConversationRuntimeOptions<never> = {
    initialSession: {
      id: "session-1",
      messages: [],
      timeline: [],
    },
    createAgent: (agentOptions) =>
      new Agent({
        model: options.model,
        tools: options.tools,
        messages: agentOptions.messages,
        beforeToolExecution: agentOptions.beforeToolExecution,
      }),
    createNewSession: () => ({ id: "session-new" }),
    forkSession: () => ({ id: "session-fork" }),
    loadSession: (sessionId) => ({
      id: sessionId,
      messages: [],
      timeline: [],
    }),
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
