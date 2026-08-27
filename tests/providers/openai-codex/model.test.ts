import { describe, expect, test } from "bun:test";
import type { Logger } from "@/logging";
import { OpenAICodexModel } from "../../../src/providers/openai-codex/model";
import { createRecordingLogger, type RecordedLog } from "../../helpers/logging";
import { messageIdentityForTest } from "../../helpers/messages";

describe("OpenAI Codex model", () => {
  test("refreshes once after a 401 and streams the retried response", async () => {
    const authorizationHeaders: string[] = [];
    const accountHeaders: string[] = [];
    const responsesLiteHeaders: Array<string | null> = [];
    const requests: Record<string, unknown>[] = [];
    const logs: RecordedLog[] = [];
    let refreshCount = 0;
    const model = new OpenAICodexModel({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      credentialProvider: {
        async getCredentials() {
          return { accessToken: "expired-token", accountId: "account-id" };
        },
        async refreshCredentials() {
          refreshCount += 1;
          return { accessToken: "refreshed-token", accountId: "account-id" };
        },
      },
      reasoningEffort: "medium",
      reasoningSummary: "auto",
      maxRetries: 0,
      logger: createRecordingLogger(logs),
      fetch: (async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorizationHeaders.push(headers.get("authorization") ?? "");
        accountHeaders.push(headers.get("chatgpt-account-id") ?? "");
        responsesLiteHeaders.push(headers.get("x-openai-internal-codex-responses-lite"));
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (authorizationHeaders.length === 1) {
          return new Response("", { status: 401 });
        }
        return sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "message-1", type: "message", role: "assistant", content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            delta: "hello",
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "message-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "hello", annotations: [] }],
            },
          },
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: [],
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            },
          },
        ]);
      }) as typeof globalThis.fetch,
    });

    const message = await model.generate({
      messages: [{ ...messageIdentityForTest("user"), role: "user", content: "hi" }],
      tools: [],
      parallelToolCalls: true,
    });

    expect(refreshCount).toBe(1);
    expect(authorizationHeaders).toEqual(["Bearer expired-token", "Bearer refreshed-token"]);
    expect(accountHeaders).toEqual(["account-id", "account-id"]);
    expect(responsesLiteHeaders).toEqual([null, null]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
      parallel_tool_calls: true,
    });
    expect(message).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "hello" }],
      usage: {
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      },
    });
    expect(logs.map((record) => record.event)).toEqual([
      "provider.request_started",
      "provider.authentication_refresh_started",
      "provider.authentication_refresh_ended",
      "provider.request_completed",
    ]);
    expect(logs[1]).toEqual({
      level: "info",
      event: "provider.authentication_refresh_started",
      metadata: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        protocol: "responses",
        phase: "authentication",
        outcome: "started",
        trigger: "http_401",
        httpStatus: 401,
      },
    });
    expect(logs[2]?.metadata).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      protocol: "responses",
      phase: "authentication",
      outcome: "refreshed",
    });
  });

  test("records authentication refresh failure without logging its message", async () => {
    const logs: RecordedLog[] = [];
    const model = new OpenAICodexModel({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      credentialProvider: {
        async getCredentials() {
          return { accessToken: "expired-token", accountId: "account-id" };
        },
        async refreshCredentials() {
          throw new Error("refresh secret");
        },
      },
      maxRetries: 0,
      logger: createRecordingLogger(logs),
      fetch: (async (_input, _init) =>
        new Response("", { status: 401 })) as typeof globalThis.fetch,
    });

    await expect(model.generate(createInput())).rejects.toThrow("refresh secret");

    expect(logs.map((record) => record.event)).toEqual([
      "provider.request_started",
      "provider.authentication_refresh_started",
      "provider.authentication_refresh_ended",
      "provider.request_failed",
    ]);
    expect(logs[2]).toEqual({
      level: "warn",
      event: "provider.authentication_refresh_ended",
      metadata: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        protocol: "responses",
        phase: "authentication",
        outcome: "failed",
        errorCode: "PROVIDER_AUTHENTICATION_ERROR",
        errorType: "Error",
      },
    });
    expect(JSON.stringify(logs)).not.toContain("refresh secret");
  });

  test("retries a transient Responses overload before output starts", async () => {
    let requestCount = 0;
    const logs: RecordedLog[] = [];
    const model = createModel(
      async () => {
        requestCount += 1;
        return requestCount === 1
          ? sseResponse([overloadEvent()], { "retry-after": "0" })
          : sseResponse(completedTextEvents("hello"));
      },
      1,
      createRecordingLogger(logs),
    );

    const message = await model.generate(createInput());

    expect(requestCount).toBe(2);
    expect(message).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "hello" }],
    });
    expect(logs.map((record) => record.event)).toEqual([
      "provider.request_started",
      "provider.stream_recovery_started",
      "provider.stream_recovery_ended",
      "provider.request_completed",
    ]);
    expect(logs[1]?.metadata).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      protocol: "responses",
      phase: "response_stream",
      outcome: "retrying",
      attempt: 1,
      delayMs: 0,
      errorCode: "PROVIDER_STREAM_TRANSIENT_ERROR",
      errorType: "ResponsesStreamError",
      eventType: "error",
      providerCode: "server_error",
    });
  });

  test("does not retry a transient stream error after assistant output starts", async () => {
    let requestCount = 0;
    const model = createModel(async () => {
      requestCount += 1;
      return requestCount === 1
        ? sseResponse([assistantOutputItem(), overloadEvent()], { "retry-after": "0" })
        : sseResponse(completedTextEvents("duplicate"));
    });

    await expect(model.generate(createInput())).rejects.toThrow(
      "Our servers are currently overloaded. Please try again later.",
    );
    expect(requestCount).toBe(1);
  });

  test("does not retry a transient stream error after hosted search starts", async () => {
    let requestCount = 0;
    const model = createModel(async () => {
      requestCount += 1;
      return requestCount === 1
        ? sseResponse([hostedSearchItem(), overloadEvent()], { "retry-after": "0" })
        : sseResponse(completedTextEvents("duplicate"));
    });

    await expect(model.generate(createInput())).rejects.toThrow(
      "Our servers are currently overloaded. Please try again later.",
    );
    expect(requestCount).toBe(1);
  });

  test("does not retry non-transient Responses stream errors", async () => {
    let requestCount = 0;
    const logs: RecordedLog[] = [];
    const model = createModel(
      async () => {
        requestCount += 1;
        return sseResponse([
          {
            type: "error",
            error: {
              code: "invalid_request_error",
              message: "The request is invalid.",
            },
          },
        ]);
      },
      1,
      createRecordingLogger(logs),
    );

    await expect(model.generate(createInput())).rejects.toThrow("The request is invalid.");
    expect(requestCount).toBe(1);
    expect(logs.at(-1)).toEqual({
      level: "error",
      event: "provider.request_failed",
      metadata: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        protocol: "responses",
        phase: "response_stream",
        outcome: "failed",
        errorCode: "PROVIDER_STREAM_ERROR",
        errorType: "ResponsesStreamError",
        eventType: "error",
        providerCode: "invalid_request_error",
      },
    });
    expect(JSON.stringify(logs)).not.toContain("The request is invalid.");
  });

  test("shares the retry budget between HTTP and stream failures", async () => {
    let requestCount = 0;
    const model = createModel(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response("temporarily unavailable", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      }
      return sseResponse([overloadEvent()], { "retry-after": "0" });
    });

    await expect(model.generate(createInput())).rejects.toThrow(
      "Our servers are currently overloaded. Please try again later.",
    );
    expect(requestCount).toBe(2);
  });
});

function createModel(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  maxRetries = 1,
  logger?: Logger,
): OpenAICodexModel {
  return new OpenAICodexModel({
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    credentialProvider: {
      async getCredentials() {
        return { accessToken: "token", accountId: "account-id" };
      },
      async refreshCredentials() {
        return undefined;
      },
    },
    maxRetries,
    logger,
    fetch: fetch as typeof globalThis.fetch,
  });
}

function createInput() {
  return {
    messages: [{ ...messageIdentityForTest("user"), role: "user" as const, content: "hi" }],
    tools: [],
    parallelToolCalls: false,
  };
}

function overloadEvent(): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "server_error",
      message: "Our servers are currently overloaded. Please try again later.",
    },
  };
}

function assistantOutputItem(): Record<string, unknown> {
  return {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "message-1", type: "message", role: "assistant", content: [] },
  };
}

function hostedSearchItem(): Record<string, unknown> {
  return {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "search-1", type: "web_search_call", status: "in_progress" },
  };
}

function completedTextEvents(text: string): Record<string, unknown>[] {
  return [
    assistantOutputItem(),
    { type: "response.output_text.delta", output_index: 0, delta: text },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "message-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    },
  ];
}

function sseResponse(
  events: Record<string, unknown>[],
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", ...extraHeaders },
  });
}
