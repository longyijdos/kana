import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  boundProviderHttpErrorBody,
  createProviderRequestSignal,
  fetchWithRetries,
  isProviderInactivityTimeout,
  MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH,
  ProviderHttpError,
} from "../../src/providers/http";
import type { ProviderRetryDetails } from "../../src/providers/lifecycle";

describe("shared provider HTTP primitives", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("marks inactivity timeout without treating an upstream abort as timeout", () => {
    jest.useFakeTimers();
    const timed = createProviderRequestSignal({
      timeoutMs: 100,
      timeoutMessage: "provider timed out",
    });

    jest.advanceTimersByTime(100);

    expect(timed.signal?.aborted).toBe(true);
    expect(timed.signal?.reason).toEqual(new Error("provider timed out"));
    expect(isProviderInactivityTimeout(timed.signal?.reason)).toBe(true);
    timed.dispose();

    const upstream = new AbortController();
    const combined = createProviderRequestSignal({
      timeoutMs: 100,
      signal: upstream.signal,
      timeoutMessage: "must not replace cancellation",
    });
    const reason = new Error("cancelled by caller");
    upstream.abort(reason);
    jest.advanceTimersByTime(100);

    expect(combined.signal?.reason).toBe(reason);
    expect(isProviderInactivityTimeout(combined.signal?.reason)).toBe(false);
    combined.dispose();
  });

  test("bounds retained HTTP error bodies", () => {
    const bounded = boundProviderHttpErrorBody(
      `${"x".repeat(MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH)}secret-tail`,
    );

    expect(bounded).toHaveLength(MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH + 1);
    expect(bounded.endsWith("…")).toBe(true);
    expect(bounded).not.toContain("secret-tail");
  });

  test("measures timeout as inactivity instead of total duration", () => {
    jest.useFakeTimers();
    const requestSignal = createProviderRequestSignal({
      timeoutMs: 100,
      timeoutMessage: "provider timed out",
    });

    jest.advanceTimersByTime(90);
    requestSignal.refresh();
    jest.advanceTimersByTime(90);
    expect(requestSignal.signal?.aborted).toBe(false);

    jest.advanceTimersByTime(10);
    expect(requestSignal.signal?.aborted).toBe(true);
    requestSignal.dispose();
  });

  test("retries retryable HTTP responses and honors Retry-After", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1;
        return requestCount === 1
          ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
          : new Response("ok");
      },
    });

    try {
      const retries: ProviderRetryDetails[] = [];
      const response = await fetchWithRetries(
        `http://127.0.0.1:${server.port}`,
        {},
        { label: "Test", maxRetries: 1, onRetry: (details) => retries.push(details) },
      );

      expect(await response.text()).toBe("ok");
      expect(requestCount).toBe(2);
      expect(retries).toEqual([
        {
          attempt: 1,
          delayMs: 0,
          errorCode: "PROVIDER_HTTP_ERROR",
          errorType: "ProviderHttpError",
          httpStatus: 429,
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("does not retry after the caller aborts with a non-DOM reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    const retries: unknown[] = [];

    const error = await fetchWithRetries(
      "http://127.0.0.1:1",
      { signal: controller.signal },
      { label: "Test", maxRetries: 2, onRetry: (details) => retries.push(details) },
    ).catch((caught) => caught);

    expect(error).toBe(reason);
    expect(retries).toEqual([]);
  });

  test("retries a 401 once with refreshed credentials before failing", async () => {
    const authorizations: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const authorization = request.headers.get("authorization") ?? "";
        authorizations.push(authorization);
        return authorization === "Bearer fresh"
          ? new Response("ok")
          : new Response("expired", { status: 401 });
      },
    });

    try {
      const response = await fetchWithRetries(
        `http://127.0.0.1:${server.port}`,
        { headers: { authorization: "Bearer stale" } },
        {
          label: "Test",
          maxRetries: 0,
          refreshOn401: async () => ({ headers: { authorization: "Bearer fresh" } }),
        },
      );

      expect(await response.text()).toBe("ok");
      expect(authorizations).toEqual(["Bearer stale", "Bearer fresh"]);
    } finally {
      server.stop(true);
    }
  });

  test("reads provider error codes and bounds the retained body", () => {
    const error = new ProviderHttpError(
      "Test API",
      400,
      "Bad Request",
      JSON.stringify({ error: { code: "bad_param", param: "model" } }),
      "req_1",
      (code) => (code ? ` Hint for ${code}.` : ""),
    );

    expect(error.providerCode).toBe("bad_param");
    expect(error.providerParam).toBe("model");
    expect(error.message).toEndWith(" Hint for bad_param. Request ID: req_1.");

    const long = new ProviderHttpError(
      "Test API",
      500,
      "Internal Server Error",
      `${"x".repeat(MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH)}secret-tail`,
    );
    expect(long.body).not.toContain("secret-tail");
  });
});
