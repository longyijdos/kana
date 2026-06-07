import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import type { AgentEvent } from "../src/agent/events";
import type { Model, ModelMetadata } from "../src/core/model";
import type { ModelContext } from "../src/core/context";
import type { AssistantMessage } from "../src/core/messages";
import { AssistantEventStream } from "../src/core/stream";

class TextModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "text",
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
    this.contexts.push({
      system: context.system,
      messages: structuredClone(context.messages),
      tools: context.tools,
      signal: context.signal,
    });

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

class AbortAwareModel implements Model {
  readonly metadata: ModelMetadata = {
    provider: "test",
    model: "abort-aware",
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };

  stream(context: ModelContext): AssistantEventStream {
    const stream = new AssistantEventStream();

    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
      };

      const abort = (): void => {
        stream.error({
          type: "error",
          reason: "aborted",
          error: context.signal?.reason ?? new Error("aborted"),
          snapshot: structuredClone(message),
        });
      };

      stream.push({
        type: "start",
        snapshot: structuredClone(message),
      });

      message.content.push({
        type: "text",
        text: "partial",
      });

      stream.push({
        type: "text_start",
        contentIndex: 0,
        snapshot: structuredClone(message),
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        snapshot: structuredClone(message),
      });

      if (context.signal?.aborted) {
        abort();
        return;
      }

      context.signal?.addEventListener("abort", abort, { once: true });
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
    expect(agent.state.messages[1]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
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
    expect(messages[0]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(events.at(0)).toMatchObject({
      type: "agent_start",
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
    });
  });

  test("returns state snapshots without exposing mutable message history", async () => {
    const agent = new Agent({
      model: new TextModel("hello"),
    });

    await agent.prompt("hi");

    const state = agent.state;
    state.messages.length = 0;

    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("passes abort signal to the running model", async () => {
    const agent = new Agent({
      model: new AbortAwareModel(),
    });
    const stream = agent.stream("hi");
    const events: AgentEvent[] = [];

    for await (const event of stream) {
      events.push(event);

      if (event.type === "message_update") {
        agent.abort();
      }
    }

    const messages = await stream.result();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
    });
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent_end",
    });
  });
});
