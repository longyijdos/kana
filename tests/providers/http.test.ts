import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  boundProviderHttpErrorBody,
  createProviderRequestSignal,
  isProviderInactivityTimeout,
  MAX_PROVIDER_HTTP_ERROR_BODY_LENGTH,
} from "../../src/providers/http";

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
});
