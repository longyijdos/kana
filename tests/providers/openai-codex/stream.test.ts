import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "../../../src/core";
import { AssistantEventStream } from "../../../src/core";
import {
  OpenAICodexStreamProcessor,
  readOpenAICodexStream,
} from "../../../src/providers/openai-codex/stream";
import type { OpenAICodexStreamState } from "../../../src/providers/openai-codex/types";

describe("OpenAI Codex stream parsing", () => {
  test("retains partial frames and dispatches multiple SSE events from one body read", async () => {
    const encoder = new TextEncoder();
    const events: Record<string, unknown>[] = [];
    let activityCount = 0;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.output_'));
          controller.enqueue(
            encoder.encode(
              'text.delta","delta":"a"}\n\ndata: {"type":"response.output_text.delta","delta":"b"}\n\n',
            ),
          );
          controller.close();
        },
      }),
    );

    await readOpenAICodexStream(
      response,
      (event) => events.push(event),
      () => {
        activityCount += 1;
      },
    );

    expect(activityCount).toBe(2);
    expect(events).toEqual([
      { type: "response.output_text.delta", delta: "a" },
      { type: "response.output_text.delta", delta: "b" },
    ]);
  });

  test("emits reasoning and text events in response output order", async () => {
    const stream = new AssistantEventStream();
    const eventsPromise = collectEvents(stream);
    const message: AssistantMessage = { role: "assistant", content: [] };
    const state: OpenAICodexStreamState = { terminalSeen: false };
    const processor = new OpenAICodexStreamProcessor(stream, message, state);

    processor.apply({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "reasoning-1", type: "reasoning", summary: [] },
    });
    processor.apply({
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      delta: "summary",
    });
    processor.apply({
      type: "response.reasoning_summary_part.done",
      output_index: 0,
    });
    processor.apply({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "reasoning-1",
        type: "reasoning",
        encrypted_content: "opaque",
        summary: [{ type: "summary_text", text: "summary" }],
      },
    });
    processor.apply({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "message-1", type: "message", role: "assistant", content: [] },
    });
    processor.apply({
      type: "response.output_text.delta",
      output_index: 1,
      delta: "hel",
    });
    processor.apply({
      type: "response.output_text.delta",
      output_index: 1,
      delta: "lo",
    });
    processor.apply({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "message-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    });
    processor.apply({
      type: "response.completed",
      response: {
        status: "completed",
        output: [],
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    });
    stream.end({
      type: "done",
      reason: state.stopReason ?? "stop",
      message: structuredClone(message),
      usage: state.usage,
    });

    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(message.content).toEqual([
      {
        type: "thinking",
        text: "summary",
        providerState: {
          provider: "openai-codex",
          value: {
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: "opaque",
            summary: [{ type: "summary_text", text: "summary" }],
          },
        },
      },
      {
        type: "text",
        text: "hello",
        providerState: {
          provider: "openai-codex",
          value: {
            id: "message-1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        },
      },
    ]);
    expect(state).toEqual({
      terminalSeen: true,
      stopReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 6,
        totalTokens: 16,
        promptCacheHitTokens: 4,
        promptCacheMissTokens: 6,
        reasoningTokens: 1,
      },
    });
  });

  test("correlates interleaved parallel function-call arguments by output index", async () => {
    const stream = new AssistantEventStream();
    const eventsPromise = collectEvents(stream);
    const message: AssistantMessage = { role: "assistant", content: [] };
    const state: OpenAICodexStreamState = { terminalSeen: false };
    const processor = new OpenAICodexStreamProcessor(stream, message, state);

    processor.apply({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "item-1",
        type: "function_call",
        call_id: "call-1",
        name: "read",
        arguments: "",
      },
    });
    processor.apply({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "item-2",
        type: "function_call",
        call_id: "call-2",
        name: "read",
        arguments: "",
      },
    });
    processor.apply({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '{"path":"b',
    });
    processor.apply({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '{"path":"a"}',
    });
    processor.apply({
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '"}',
    });
    processor.apply({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        id: "item-2",
        type: "function_call",
        call_id: "call-2",
        name: "read",
        arguments: '{"path":"b"}',
      },
    });
    processor.apply({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "item-1",
        type: "function_call",
        call_id: "call-1",
        name: "read",
        arguments: '{"path":"a"}',
      },
    });
    processor.apply({
      type: "response.completed",
      response: {
        status: "completed",
        output: [],
      },
    });
    stream.end({
      type: "done",
      reason: state.stopReason ?? "stop",
      message: structuredClone(message),
    });

    const events = await eventsPromise;

    expect(message.content).toEqual([
      expect.objectContaining({
        type: "tool_call",
        id: "call-1",
        args: { path: "a" },
      }),
      expect.objectContaining({
        type: "tool_call",
        id: "call-2",
        args: { path: "b" },
      }),
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
    expect(state.stopReason).toBe("toolUse");
  });
});

async function collectEvents(stream: AssistantEventStream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
