import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentEvent } from "../src/agent/events";
import { runAgentLoop } from "../src/agent/loop";
import type { ModelContext } from "../src/core/context";
import type { AssistantMessage } from "../src/core/messages";
import type { Model, ModelMetadata } from "../src/core/model";
import { AssistantEventStream } from "../src/core/stream";
import type { Tool } from "../src/tools/tool";

class ScriptedToolModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "scripted-tool",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };
  readonly contexts: ModelContext[] = [];

  constructor(
    private readonly toolArgs: unknown = { a: "2", b: 3 },
    private readonly toolTurnCount = 1,
  ) {}

  stream(context: ModelContext): AssistantEventStream {
    this.contexts.push({
      system: context.system,
      messages: structuredClone(context.messages),
      tools: context.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });

    const stream = new AssistantEventStream();
    const callIndex = this.contexts.length;

    queueMicrotask(() => {
      if (callIndex <= this.toolTurnCount) {
        streamToolCallMessage(stream, this.toolArgs);
        return;
      }

      streamTextMessage(stream, "The result is 5.");
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

class MultiToolCallModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "multi-tool-call",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };

  stream(_context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      streamMultipleToolCallMessage(stream);
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

class AbortedModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "aborted",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };

  stream(_context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      stream.error({
        type: "error",
        reason: "aborted",
        error: new Error("aborted"),
        snapshot: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "partial",
            },
          ],
        },
      });
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

class AbortedToolCallModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "aborted-tool-call",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };

  stream(_context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
      };

      stream.push({
        type: "start",
        snapshot: structuredClone(message),
      });

      message.content.push({
        type: "tool_call",
        id: "call_1",
        name: "edit",
        args: {
          path: "foo.ts",
          oldText: "before",
          newText: "after",
        },
        rawArgs: '{"path":"foo.ts"',
      });

      stream.push({
        type: "toolcall_start",
        contentIndex: 0,
        snapshot: structuredClone(message),
      });
      stream.error({
        type: "error",
        reason: "aborted",
        error: new Error("aborted"),
        snapshot: structuredClone(message),
      });
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

class EmptyErrorModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "empty-error",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };

  stream(_context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      stream.error({
        type: "error",
        reason: "error",
        error: new Error("provider rejected the request"),
        snapshot: {
          role: "assistant",
          content: [],
        },
      });
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

class LengthTruncatedToolModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "length-truncated-tool",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };
  readonly contexts: ModelContext[] = [];

  stream(context: ModelContext): AssistantEventStream {
    this.contexts.push({
      system: context.system,
      messages: structuredClone(context.messages),
      tools: context.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });

    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      streamLengthTruncatedToolCallMessage(stream);
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

const addParameters = Type.Object({
  a: Type.Number(),
  b: Type.Number(),
});

const addTool = {
  name: "add",
  description: "Add two numbers.",
  parameters: addParameters,
  execute: ({ a, b }) => ({
    content: String(a + b),
    result: a + b,
  }),
} satisfies Tool<typeof addParameters, number>;

describe("runAgentLoop", () => {
  test("streams assistant turns and executes requested tools", async () => {
    const model = new ScriptedToolModel();
    const events: AgentEvent[] = [];

    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "add the numbers",
          },
        ],
        tools: [addTool],
      },
      {
        model,
        maxTurns: 3,
      },
      (event) => {
        events.push(structuredClone(event));
      },
    );

    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      toolName: "add",
      content: "5",
      result: 5,
      isError: false,
    });
    expect(model.contexts).toHaveLength(2);
    expect(model.contexts[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "5",
    });
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
    expect(
      events
        .filter((event) => event.type === "message_start" || event.type === "message_end")
        .every((event) => event.message.role === "assistant"),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      reason: "stop",
    });
  });

  test("turns invalid tool arguments into error tool results", async () => {
    const model = new ScriptedToolModel({
      a: 1,
    });

    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "add the numbers",
          },
        ],
        tools: [addTool],
      },
      {
        model,
        maxTurns: 2,
      },
      () => {},
    );

    const toolResult = messages[1];

    expect(toolResult).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      toolName: "add",
      isError: true,
    });
    expect(toolResult?.role).toBe("tool");
    if (toolResult?.role !== "tool") {
      throw new Error("Expected third message to be a tool result.");
    }
    expect(toolResult.content).toContain("Validation failed");
    expect(toolResult.result).toMatchObject({
      error: expect.stringContaining('Validation failed for tool "add"'),
    });
  });

  test("runs the before-tool hook before executing a tool call", async () => {
    const beforeCalls: unknown[] = [];
    let executed = false;

    const tool = {
      ...addTool,
      execute: ({ a, b }) => {
        executed = true;

        return {
          content: String(a + b),
          result: a + b,
        };
      },
    } satisfies Tool<typeof addParameters, number>;

    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "add the numbers",
          },
        ],
        tools: [tool],
      },
      {
        model: new ScriptedToolModel(),
        maxTurns: 2,
        beforeToolExecution: ({ args }) => {
          beforeCalls.push(args);

          return {
            type: "continue",
          };
        },
      },
      () => {},
    );

    expect(beforeCalls).toEqual([{ a: 2, b: 3 }]);
    expect(executed).toBe(true);
    expect(messages[1]).toMatchObject({
      role: "tool",
      content: "5",
      isError: false,
    });
  });

  test("cancels a tool call without executing it or continuing the loop", async () => {
    const model = new ScriptedToolModel();
    const events: AgentEvent[] = [];
    let executed = false;

    const tool = {
      ...addTool,
      execute: () => {
        executed = true;

        return {
          content: "unexpected",
          result: "unexpected",
        };
      },
    } satisfies Tool<typeof addParameters, string>;

    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "add the numbers",
          },
        ],
        tools: [tool],
      },
      {
        model,
        maxTurns: 3,
        beforeToolExecution: () => ({
          type: "cancel",
          abortRun: true,
          message: "Tool call rejected by user.",
        }),
      },
      (event) => {
        events.push(structuredClone(event));
      },
    );

    expect(executed).toBe(false);
    expect(model.contexts).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      toolName: "add",
      content: "Tool call rejected by user.",
      isError: true,
      result: {
        canceled: true,
      },
    });
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      reason: "aborted",
    });
  });

  test("adds canceled results for remaining tool calls when aborting a run", async () => {
    const beforeToolCallIds: string[] = [];
    let executeCount = 0;

    const tool = {
      ...addTool,
      execute: ({ a, b }) => {
        executeCount += 1;

        return {
          content: String(a + b),
          result: a + b,
        };
      },
    } satisfies Tool<typeof addParameters, number>;

    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "add both numbers",
          },
        ],
        tools: [tool],
      },
      {
        model: new MultiToolCallModel(),
        maxTurns: 2,
        beforeToolExecution: ({ toolCall }) => {
          beforeToolCallIds.push(toolCall.id);

          return {
            type: "cancel",
            abortRun: true,
            message: "Tool call rejected by user.",
          };
        },
      },
      () => {},
    );

    expect(executeCount).toBe(0);
    expect(beforeToolCallIds).toEqual(["call_1"]);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      toolName: "add",
      content: "Tool call rejected by user.",
      isError: true,
      result: {
        canceled: true,
      },
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_2",
      toolName: "add",
      content: "Tool call canceled because the run was aborted.",
      isError: true,
      result: {
        canceled: true,
      },
    });
  });

  test("runs without a turn limit when maxTurns is -1", async () => {
    const model = new ScriptedToolModel({ a: 2, b: 3 }, 10);

    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "keep using tools",
          },
        ],
        tools: [addTool],
      },
      {
        model,
        maxTurns: -1,
      },
      () => {},
    );

    expect(model.contexts).toHaveLength(11);
    expect(messages).toHaveLength(21);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  });

  test("does not execute tool calls from length-truncated assistant turns", async () => {
    const model = new LengthTruncatedToolModel();
    const events: AgentEvent[] = [];

    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "write a long file",
          },
        ],
        tools: [addTool],
      },
      {
        model,
      },
      (event) => {
        events.push(structuredClone(event));
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      stopReason: "length",
    });
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
    expect(model.contexts).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      reason: "length",
    });
  });

  test("records aborted assistant turns on the final message", async () => {
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "hi",
          },
        ],
      },
      {
        model: new AbortedModel(),
      },
      (event) => {
        events.push(structuredClone(event));
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
      content: [
        {
          type: "text",
          text: "partial",
        },
      ],
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      reason: "aborted",
    });
  });

  test("does not persist empty provider error messages", async () => {
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "hi",
          },
        ],
      },
      {
        model: new EmptyErrorModel(),
      },
      (event) => {
        events.push(structuredClone(event));
      },
    );

    expect(messages).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      reason: "error",
      messages: [],
    });
  });

  test("does not persist aborted partial tool calls without tool results", async () => {
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop(
      {
        messages: [
          {
            role: "user",
            content: "edit the file",
          },
        ],
        tools: [addTool],
      },
      {
        model: new AbortedToolCallModel(),
      },
      (event) => {
        events.push(structuredClone(event));
      },
    );

    expect(messages).toEqual([]);
    expect(events.some((event) => event.type === "message_update")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
      reason: "aborted",
      messages: [],
    });
  });
});

function streamToolCallMessage(stream: AssistantEventStream, args: unknown): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
  };

  stream.push({
    type: "start",
    snapshot: structuredClone(message),
  });

  const toolCall = {
    type: "tool_call",
    id: "call_1",
    name: "add",
    args,
    rawArgs: JSON.stringify(args),
  } as const;

  message.content.push(toolCall);

  stream.push({
    type: "toolcall_start",
    contentIndex: 0,
    snapshot: structuredClone(message),
  });
  stream.push({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    snapshot: structuredClone(message),
  });
  stream.end({
    type: "done",
    reason: "toolUse",
    message: structuredClone(message),
  });
}

function streamMultipleToolCallMessage(stream: AssistantEventStream): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
  };

  stream.push({
    type: "start",
    snapshot: structuredClone(message),
  });

  const toolCalls = [
    {
      type: "tool_call",
      id: "call_1",
      name: "add",
      args: { a: 1, b: 2 },
      rawArgs: '{"a":1,"b":2}',
    },
    {
      type: "tool_call",
      id: "call_2",
      name: "add",
      args: { a: 3, b: 4 },
      rawArgs: '{"a":3,"b":4}',
    },
  ] as const;

  for (const [index, toolCall] of toolCalls.entries()) {
    message.content.push(toolCall);

    stream.push({
      type: "toolcall_start",
      contentIndex: index,
      snapshot: structuredClone(message),
    });
    stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall,
      snapshot: structuredClone(message),
    });
  }

  stream.end({
    type: "done",
    reason: "toolUse",
    message: structuredClone(message),
  });
}

function streamLengthTruncatedToolCallMessage(stream: AssistantEventStream): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
  };

  stream.push({
    type: "start",
    snapshot: structuredClone(message),
  });

  message.content.push({
    type: "tool_call",
    id: "call_1",
    name: "add",
    args: undefined,
    rawArgs: '{"a":',
  });

  stream.push({
    type: "toolcall_start",
    contentIndex: 0,
    snapshot: structuredClone(message),
  });
  stream.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: '{"a":',
    snapshot: structuredClone(message),
  });
  stream.end({
    type: "done",
    reason: "length",
    message: structuredClone(message),
  });
}

function streamTextMessage(stream: AssistantEventStream, text: string): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
  };

  stream.push({
    type: "start",
    snapshot: structuredClone(message),
  });

  message.content.push({
    type: "text",
    text,
  });

  stream.push({
    type: "text_start",
    contentIndex: 0,
    snapshot: structuredClone(message),
  });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    snapshot: structuredClone(message),
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    snapshot: structuredClone(message),
  });
  stream.end({
    type: "done",
    reason: "stop",
    message: structuredClone(message),
  });
}
