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
});

async function collectEventTypes(stream: AssistantEventStream): Promise<string[]> {
  const events: string[] = [];

  for await (const event of stream) {
    events.push(event.type);
  }

  return events;
}
