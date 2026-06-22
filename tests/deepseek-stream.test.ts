import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "../src/core";
import { AssistantEventStream } from "../src/core";
import {
  applyDeepSeekChunk,
  finishOpenContent,
  finishToolCalls,
  getDoneReason,
} from "../src/providers/deepseek/stream";
import type { DeepSeekStreamState } from "../src/providers/deepseek/types";

describe("DeepSeek stream parsing", () => {
  test("emits thinking, text, and tool call events in content order", async () => {
    const stream = new AssistantEventStream();
    const eventsPromise = collectEventTypes(stream);
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
    };
    const state: DeepSeekStreamState = {
      endedContentIndexes: new Set<number>(),
    };

    stream.push({
      type: "start",
      snapshot: structuredClone(message),
    });
    applyDeepSeekChunk(stream, message, state, {
      choices: [
        {
          delta: {
            reasoning_content: "thinking",
          },
        },
      ],
    });
    applyDeepSeekChunk(stream, message, state, {
      choices: [
        {
          delta: {
            content: "answer",
          },
        },
      ],
    });
    applyDeepSeekChunk(stream, message, state, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: {
                  name: "read",
                  arguments: '{"path":"a',
                },
              },
            ],
          },
        },
      ],
    });
    applyDeepSeekChunk(stream, message, state, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: '.ts"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    finishOpenContent(stream, message, state);
    finishToolCalls(stream, message, state);
    stream.end({
      type: "done",
      reason: getDoneReason(state.finishReason),
      message: structuredClone(message),
    });

    expect(await eventsPromise).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
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
      {
        type: "thinking",
        text: "thinking",
      },
      {
        type: "text",
        text: "answer",
      },
      {
        type: "tool_call",
        id: "call_1",
        name: "read",
        rawArgs: '{"path":"a.ts"}',
        args: {
          path: "a.ts",
        },
      },
    ]);
  });

  test("captures usage from the stream chunk", () => {
    const stream = new AssistantEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
    };
    const state: DeepSeekStreamState = {
      endedContentIndexes: new Set<number>(),
    };

    applyDeepSeekChunk(stream, message, state, {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 90,
        prompt_cache_miss_tokens: 10,
        completion_tokens_details: {
          reasoning_tokens: 5,
        },
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
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
    };
    const state: DeepSeekStreamState = {
      endedContentIndexes: new Set<number>(),
    };

    applyDeepSeekChunk(stream, message, state, {
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
    applyDeepSeekChunk(stream, message, state, {
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
    finishToolCalls(stream, message, state);
    stream.end({
      type: "done",
      reason: getDoneReason(state.finishReason),
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
});

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
