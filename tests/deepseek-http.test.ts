import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRequestSignal } from "../src/providers/deepseek/http";

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
