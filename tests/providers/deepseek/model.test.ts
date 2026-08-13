import { describe, expect, test } from "bun:test";
import { DeepSeekModel } from "../../../src/providers/deepseek/model";

describe("DeepSeek model protocol routing", () => {
  test("routes V4 Flash through Responses and maps hosted web search items", async () => {
    let requestPath = "";
    let requestBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        requestBody = (await request.json()) as Record<string, unknown>;
        return responsesSse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "search-1", type: "web_search_call", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "search-1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                queries: ["latest DeepSeek release", "ws_call_id=search-1"],
              },
            },
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { id: "open-1", type: "web_search_call", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              id: "open-1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "open_page",
                url: "https://example.com/releases#ws_call_id=open-1",
              },
            },
          },
          {
            type: "response.output_item.added",
            output_index: 2,
            item: { id: "message-1", type: "message", role: "assistant", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 2,
            delta: "answer",
          },
          {
            type: "response.output_item.done",
            output_index: 2,
            item: {
              id: "message-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "answer", annotations: [] }],
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [],
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                total_tokens: 14,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens_details: { reasoning_tokens: 2 },
              },
            },
          },
        ]);
      },
    });

    try {
      const model = new DeepSeekModel({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.port}`,
        thinking: true,
        reasoningEffort: "max",
        webSearch: true,
        maxRetries: 0,
      });
      const message = await model.generate({
        messages: [{ role: "user", content: "What is new?" }],
        maxOutputTokens: 2_048,
      });

      expect(requestPath).toBe("/responses");
      expect(requestBody).toMatchObject({
        model: "deepseek-v4-flash",
        stream: true,
        max_output_tokens: 2_048,
        reasoning: { effort: "max" },
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      });
      expect(message).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "hosted_tool",
            id: "search-1",
            name: "web_search",
            status: "completed",
            action: { type: "search", queries: ["latest DeepSeek release"] },
            providerState: {
              provider: "deepseek",
              value: {
                action: {
                  queries: ["latest DeepSeek release", "ws_call_id=search-1"],
                },
              },
            },
          },
          {
            type: "hosted_tool",
            id: "open-1",
            name: "web_search",
            status: "completed",
            action: { type: "open_page", url: "https://example.com/releases" },
            providerState: {
              provider: "deepseek",
              value: {
                action: {
                  url: "https://example.com/releases#ws_call_id=open-1",
                },
              },
            },
          },
          {
            type: "text",
            text: "answer",
            providerState: {
              provider: "deepseek",
            },
          },
        ],
        usage: {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
          promptCacheHitTokens: 3,
          promptCacheMissTokens: 7,
          reasoningTokens: 2,
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("routes V4 Pro through Responses with hosted search and low reasoning", async () => {
    let requestPath = "";
    let requestBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        requestBody = (await request.json()) as Record<string, unknown>;
        return responsesSse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "message-1", type: "message", role: "assistant", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            delta: "answer",
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "message-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "answer", annotations: [] }],
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [],
              usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
            },
          },
        ]);
      },
    });

    try {
      const model = new DeepSeekModel({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.port}`,
        thinking: true,
        reasoningEffort: "low",
        webSearch: true,
        maxRetries: 0,
      });
      const message = await model.generate({
        messages: [{ role: "user", content: "hello" }],
        maxOutputTokens: 2_048,
      });

      expect(requestPath).toBe("/responses");
      expect(requestBody).toMatchObject({
        model: "deepseek-v4-pro",
        stream: true,
        max_output_tokens: 2_048,
        reasoning: { effort: "low" },
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      });
      expect(message).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "answer" }],
      });
    } finally {
      server.stop(true);
    }
  });
});

function responsesSse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
