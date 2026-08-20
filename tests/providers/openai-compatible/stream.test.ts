import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "../../../src/core";
import { AssistantEventStream } from "../../../src/core";
import {
  applyOpenAICompatibleChunk,
  finishOpenAICompatibleContent,
  finishOpenAICompatibleToolCalls,
  getOpenAICompatibleDoneReason,
  readOpenAICompatibleStream,
} from "../../../src/providers/openai-compatible/stream";
import type { OpenAICompatibleStreamState } from "../../../src/providers/openai-compatible/types";
import { messageIdentityForTest } from "../../helpers/messages";

describe("OpenAI-compatible stream parsing", () => {
  test("reports raw stream activity for heartbeats and data frames", async () => {
    const encoder = new TextEncoder();
    let activityCount = 0;
    const chunks: unknown[] = [];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
          controller.close();
        },
      }),
    );

    await readOpenAICompatibleStream(
      response,
      (chunk) => chunks.push(chunk),
      () => {
        activityCount += 1;
      },
    );

    expect(activityCount).toBe(2);
    expect(chunks).toHaveLength(1);
  });

  test("emits text and tool call events in content order", async () => {
    const stream = new AssistantEventStream();
    const eventsPromise = collectEventTypes(stream);
    const message = createMessage();
    const state = createState();

    stream.push({ type: "start", snapshot: structuredClone(message) });
    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [{ delta: { content: "answer" } }],
    });
    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "read", arguments: '{"path":"a' },
              },
            ],
          },
        },
      ],
    });
    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    finishOpenAICompatibleContent(stream, message, state);
    finishOpenAICompatibleToolCalls(stream, message, state);
    stream.end({
      type: "done",
      reason: getOpenAICompatibleDoneReason(state.finishReason),
      message: structuredClone(message),
    });

    expect(await eventsPromise).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(message.content).toEqual([
      { type: "text", text: "answer" },
      {
        type: "tool_call",
        id: "call_1",
        name: "read",
        rawArgs: '{"path":"a.ts"}',
        args: { path: "a.ts" },
      },
    ]);
  });

  test("maps reasoning content to thinking events before visible text", async () => {
    const stream = new AssistantEventStream();
    const eventsPromise = collectEventTypes(stream);
    const message = createMessage();
    const state = createState();

    stream.push({ type: "start", snapshot: structuredClone(message) });
    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [{ delta: { reasoning_content: "plan " } }],
    });
    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [{ delta: { reasoning_content: "steps" } }],
    });
    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [{ delta: { content: "answer" }, finish_reason: "stop" }],
    });
    finishOpenAICompatibleContent(stream, message, state);
    stream.end({ type: "done", reason: "stop", message: structuredClone(message) });

    expect(await eventsPromise).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(message.content).toEqual([
      { type: "thinking", text: "plan steps" },
      { type: "text", text: "answer" },
    ]);
  });

  test("captures standard and detailed usage fields", () => {
    const stream = new AssistantEventStream();
    const message = createMessage();
    const state = createState();

    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 90 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });

    expect(state.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      promptCacheHitTokens: 90,
      promptCacheMissTokens: 10,
      reasoningTokens: 5,
    });
  });

  test("ends each ordered tool call when the next one starts", async () => {
    const stream = new AssistantEventStream();
    const eventsPromise = collectEvents(stream);
    const message = createMessage();
    const state = createState();

    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "write", arguments: '{"path":"one"}' },
              },
            ],
          },
        },
      ],
    });
    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call_2",
                function: { name: "write", arguments: '{"path":"two"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    finishOpenAICompatibleToolCalls(stream, message, state);
    stream.end({
      type: "done",
      reason: getOpenAICompatibleDoneReason(state.finishReason),
      message: structuredClone(message),
    });

    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(events[2]).toMatchObject({
      type: "toolcall_end",
      toolCall: { id: "call_1", args: { path: "one" } },
    });
  });

  test("rejects unsupported finish reasons and incomplete tool calls", () => {
    const stream = new AssistantEventStream();
    const message = createMessage();
    const state = createState();

    expect(() =>
      applyOpenAICompatibleChunk(stream, message, state, {
        choices: [{ finish_reason: "content_filter" }],
      }),
    ).toThrow("unsupported reason content_filter");

    applyOpenAICompatibleChunk(stream, message, state, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }],
    });
    expect(() => finishOpenAICompatibleToolCalls(stream, message, state)).toThrow(
      "incomplete tool call",
    );
  });
});

function createMessage(): AssistantMessage {
  return {
    ...messageIdentityForTest("assistant"),
    role: "assistant",
    content: [],
  };
}

function createState(): OpenAICompatibleStreamState {
  return { endedContentIndexes: new Set<number>() };
}

async function collectEventTypes(stream: AssistantEventStream): Promise<string[]> {
  const events: string[] = [];
  for await (const event of stream) {
    events.push(event.type);
  }
  return events;
}

async function collectEvents(stream: AssistantEventStream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
