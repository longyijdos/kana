import { afterEach, describe, expect, jest, test } from "bun:test";
import { ContextWindowExceededError } from "@/core";
import {
  createRequestSignal,
  DeepSeekHttpError,
  fetchWithRetries,
} from "../../../src/providers/deepseek/http";
import { DeepSeekModel } from "../../../src/providers/deepseek/model";
import { MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH } from "../../../src/providers/http";

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

  test("does not retry after a combined signal aborts with a non-DOM reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    const retries: unknown[] = [];

    const error = await fetchWithRetries(
      "http://127.0.0.1:1",
      { signal: controller.signal },
      2,
      (details) => retries.push(details),
    ).catch((caught) => caught);

    expect(error).toBe(reason);
    expect(retries).toEqual([]);
  });

  test("bounds the error body retained by DeepSeekHttpError", () => {
    const error = new DeepSeekHttpError(
      500,
      "Internal Server Error",
      `${"x".repeat(MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH)}secret-tail`,
    );

    expect(error.body).toHaveLength(MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH + 1);
    expect(error.body.endsWith("…")).toBe(true);
    expect(error.body).not.toContain("secret-tail");
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
