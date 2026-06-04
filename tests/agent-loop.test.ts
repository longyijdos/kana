import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentEvent } from "../src/agent/events";
import { runAgentLoop } from "../src/agent/loop";
import type { Model, ModelMetadata } from "../src/core/model";
import type { ModelContext } from "../src/core/context";
import type { AssistantMessage } from "../src/core/messages";
import { AssistantEventStream } from "../src/core/stream";
import type { Tool } from "../src/tools/tool";

class ScriptedToolModel implements Model {
  readonly metadata: ModelMetadata = {
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

  constructor(private readonly toolArgs: unknown = { a: "2", b: 3 }) {}

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
      if (callIndex === 1) {
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

class AbortedModel implements Model {
  readonly metadata: ModelMetadata = {
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

    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
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
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(
      true,
    );
    expect(
      events
        .filter(
          (event) =>
            event.type === "message_start" || event.type === "message_end",
        )
        .every((event) => event.message.role === "assistant"),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
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

  test("records aborted assistant turns on the final message", async () => {
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
      () => {},
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
  });
});

function streamToolCallMessage(
  stream: AssistantEventStream,
  args: unknown,
): void {
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

function streamTextMessage(
  stream: AssistantEventStream,
  text: string,
): void {
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
