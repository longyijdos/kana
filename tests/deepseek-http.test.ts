import { afterEach, describe, expect, jest, test } from "bun:test";
import { ContextWindowExceededError } from "@/core";
import { createRequestSignal } from "../src/providers/deepseek/http";
import { DeepSeekModel } from "../src/providers/deepseek/model";

describe("DeepSeek request timeout", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("measures inactivity instead of total request duration", () => {
    jest.useFakeTimers();
    const requestSignal = createRequestSignal({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      timeoutMs: 100,
    });

    jest.advanceTimersByTime(90);
    requestSignal.refresh();
    jest.advanceTimersByTime(90);

    expect(requestSignal.signal?.aborted).toBe(false);

    jest.advanceTimersByTime(10);

    expect(requestSignal.signal?.aborted).toBe(true);
    expect(requestSignal.signal?.reason).toEqual(
      new Error("DeepSeek request timed out after 100ms."),
    );
    requestSignal.dispose();
  });
});

describe("DeepSeek context-limit errors", () => {
  test("maps a recognized provider response to ContextWindowExceededError", async () => {
    const server = createErrorServer(
      400,
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "Maximum context length exceeded.",
        },
      }),
    );

    try {
      const model = createModelForServer(server);

      await expect(model.generate({ messages: [] })).rejects.toBeInstanceOf(
        ContextWindowExceededError,
      );
    } finally {
      server.stop(true);
    }
  });

  test("does not map unrelated client errors to context-limit recovery", async () => {
    const server = createErrorServer(
      400,
      JSON.stringify({
        error: {
          code: "invalid_request",
          message: "The temperature field is invalid.",
        },
      }),
    );

    try {
      const model = createModelForServer(server);
      const error = await model.generate({ messages: [] }).catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ContextWindowExceededError);
      expect(String(error)).toContain("400");
    } finally {
      server.stop(true);
    }
  });
});

function createErrorServer(status: number, body: string): Bun.Server<undefined> {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(body, {
        status,
        headers: {
          "content-type": "application/json",
        },
      }),
  });
}

function createModelForServer(server: Bun.Server<undefined>): DeepSeekModel {
  return new DeepSeekModel({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${server.port}`,
    maxRetries: 0,
  });
}
