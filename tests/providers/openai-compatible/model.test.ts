import { describe, expect, test } from "bun:test";
import { ContextWindowExceededError } from "@/core";
import { OpenAICompatibleModel, type OpenAICompatibleModelConfig } from "../../../src/providers";
import { messageIdentityForTest } from "../../helpers/messages";

describe("OpenAICompatibleModel", () => {
  test("streams Chat Completions text and usage from the configured endpoint", async () => {
    let requestPath = "";
    let authorization = "";
    let requestBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        authorization = request.headers.get("authorization") ?? "";
        requestBody = (await request.json()) as Record<string, unknown>;
        return completionSse([
          { choices: [{ index: 0, delta: { content: "answer" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
              prompt_tokens_details: { cached_tokens: 4 },
            },
          },
        ]);
      },
    });

    try {
      const model = createModel(server, { apiKey: "test-key" });
      const message = await model.generate({
        messages: [{ ...messageIdentityForTest("user"), role: "user", content: "hello" }],
        maxOutputTokens: 1_024,
      });

      expect(model.metadata).toMatchObject({
        provider: "compatible",
        model: "compatible-model",
        protocol: "chat-completions",
      });
      expect(requestPath).toBe("/v1/chat/completions");
      expect(authorization).toBe("Bearer test-key");
      expect(requestBody).toMatchObject({
        model: "compatible-model",
        stream: true,
        max_tokens: 1_024,
      });
      expect(message).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "answer" }],
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          promptCacheHitTokens: 4,
          promptCacheMissTokens: 6,
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("maps recognized context-limit responses without hiding other client errors", async () => {
    const contextServer = createErrorServer(
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "Maximum context length exceeded.",
        },
      }),
    );
    const parameterServer = createErrorServer(
      JSON.stringify({ error: { code: "invalid_request", message: "Invalid temperature." } }),
    );

    try {
      await expect(createModel(contextServer).generate({ messages: [] })).rejects.toBeInstanceOf(
        ContextWindowExceededError,
      );
      const error = await createModel(parameterServer)
        .generate({ messages: [] })
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ContextWindowExceededError);
      expect(String(error)).toContain("400");
    } finally {
      contextServer.stop(true);
      parameterServer.stop(true);
    }
  });

  test("rejects output limits above model metadata before network I/O", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1;
        return completionSse([]);
      },
    });

    try {
      const model = createModel(server, { maxTokens: 16_384 });
      await expect(model.generate({ messages: [] })).rejects.toThrow("at most 8192 output tokens");
      expect(requestCount).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

function createModel(
  server: Bun.Server<undefined>,
  overrides: Partial<OpenAICompatibleModelConfig> = {},
): OpenAICompatibleModel {
  return new OpenAICompatibleModel({
    provider: "compatible",
    model: "compatible-model",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    metadata: {
      contextWindow: 32_768,
      maxOutputTokens: 8_192,
      supportsParallelToolCalls: true,
      supportsHostedWebSearch: false,
      supportsImageInput: false,
    },
    maxRetries: 0,
    ...overrides,
  });
}

function completionSse(chunks: Record<string, unknown>[]): Response {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function createErrorServer(body: string): Bun.Server<undefined> {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
  });
}
