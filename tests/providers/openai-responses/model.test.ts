import { describe, expect, test } from "bun:test";
import { ContextWindowExceededError } from "@/core";
import { OpenAIResponsesModel, type OpenAIResponsesModelConfig } from "../../../src/providers";
import { messageIdentityForTest } from "../../helpers/messages";

describe("OpenAIResponsesModel", () => {
  test("streams function calls and hosted web search from the configured endpoint", async () => {
    let requestPath = "";
    let authorization = "";
    let requestBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        authorization = request.headers.get("authorization") ?? "";
        requestBody = (await request.json()) as Record<string, unknown>;
        return responsesSse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "ws-1", type: "web_search_call", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "ws-1",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", query: "kana release" },
            },
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { id: "fc-1", type: "function_call", call_id: "call-1", name: "read" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 1,
            item_id: "fc-1",
            delta: '{"path":"a.ts"}',
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              id: "fc-1",
              type: "function_call",
              call_id: "call-1",
              name: "read",
              arguments: '{"path":"a.ts"}',
            },
          },
          {
            type: "response.completed",
            response: {
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            },
          },
        ]);
      },
    });

    try {
      const model = createModel(server, { apiKey: "test-key" });
      const message = await model.generate({
        messages: [{ ...messageIdentityForTest("user"), role: "user", content: "search" }],
        tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
        webSearch: true,
      });

      expect(model.metadata).toMatchObject({
        provider: "custom",
        model: "responses-model",
        protocol: "responses",
        supportsHostedWebSearch: true,
      });
      expect(requestPath).toBe("/v1/responses");
      expect(authorization).toBe("Bearer test-key");
      expect(requestBody).toMatchObject({
        model: "responses-model",
        stream: true,
        tools: [{ type: "function", name: "read" }, { type: "web_search" }],
      });
      expect(message).toMatchObject({
        stopReason: "toolUse",
        content: [
          {
            type: "hosted_tool",
            id: "ws-1",
            name: "web_search",
            status: "completed",
            action: { type: "search", query: "kana release" },
          },
          { type: "tool_call", id: "call-1", name: "read", args: { path: "a.ts" } },
        ],
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      });
    } finally {
      server.stop(true);
    }
  });

  test("maps a recognized context-limit response to ContextWindowExceededError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            error: { code: "context_length_exceeded", message: "Too many tokens." },
          }),
          { status: 400 },
        ),
    });

    try {
      await expect(createModel(server).generate({ messages: [] })).rejects.toBeInstanceOf(
        ContextWindowExceededError,
      );
    } finally {
      server.stop(true);
    }
  });
});

function createModel(
  server: { port: number | undefined },
  overrides: Partial<OpenAIResponsesModelConfig> = {},
): OpenAIResponsesModel {
  return new OpenAIResponsesModel({
    provider: "custom",
    model: "responses-model",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    maxRetries: 0,
    metadata: {
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      supportsParallelToolCalls: false,
      supportsHostedWebSearch: true,
      supportsImageInput: false,
    },
    ...overrides,
  });
}

function responsesSse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
