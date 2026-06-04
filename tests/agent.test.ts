import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import type { AgentEvent } from "../src/agent/events";
import type { Model, ModelMetadata } from "../src/core/model";
import type { ModelContext } from "../src/core/context";
import type { AssistantMessage } from "../src/core/messages";
import { AssistantEventStream } from "../src/core/stream";

class TextModel implements Model {
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

  constructor(private readonly response = "hello") {}

  stream(context: ModelContext): AssistantEventStream {
    this.contexts.push(structuredClone(context));

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
        type: "text",
        text: this.response,
      });

      stream.push({
        type: "text_start",
        contentIndex: 0,
        snapshot: structuredClone(message),
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: this.response,
        snapshot: structuredClone(message),
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: this.response,
        snapshot: structuredClone(message),
      });
      stream.end({
        type: "done",
        reason: "stop",
        message: structuredClone(message),
      });
    });

    return stream;
  }

  generate(context: ModelContext): Promise<AssistantMessage> {
    return this.stream(context).result();
  }
}

describe("Agent", () => {
  test("runs prompts and appends loop messages once", async () => {
    const model = new TextModel("hello");
    const agent = new Agent({ model });
    const events: AgentEvent[] = [];
    const streamingRoles: string[] = [];

    agent.subscribe((event) => {
      events.push(structuredClone(event));
      if (event.type === "message_update") {
        streamingRoles.push(agent.state.streamingMessage?.role ?? "none");
      }
    });

    await agent.prompt("hi");

    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.pendingToolCalls.size).toBe(0);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(streamingRoles).toEqual(["assistant", "assistant", "assistant"]);
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
    });
  });

  test("streams agent events from the stateful agent", async () => {
    const agent = new Agent({
      model: new TextModel("streamed"),
    });
    const stream = agent.stream("hi");
    const events: AgentEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    const messages = await stream.result();

    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
    ]);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(agent.state.messages.slice(1)).toEqual(messages);
    expect(events.at(0)).toMatchObject({
      type: "agent_start",
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
    });
  });

});
