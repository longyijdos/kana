import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ProviderRetryDetails } from "../../../src/providers/lifecycle";
import {
  createOpenAICompatibleRequestSignal,
  fetchOpenAICompatibleWithRetries,
} from "../../../src/providers/openai-compatible/http";
import type { OpenAICompatibleModelConfig } from "../../../src/providers/openai-compatible/types";

describe("OpenAI-compatible HTTP", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("measures timeout as inactivity instead of total duration", () => {
    jest.useFakeTimers();
    const requestSignal = createOpenAICompatibleRequestSignal(createConfig({ timeoutMs: 100 }));

    jest.advanceTimersByTime(90);
    requestSignal.refresh();
    jest.advanceTimersByTime(90);
    expect(requestSignal.signal?.aborted).toBe(false);

    jest.advanceTimersByTime(10);
    expect(requestSignal.signal?.aborted).toBe(true);
    expect(requestSignal.signal?.reason).toEqual(
      new Error(
        "OpenAI-compatible provider compatible/compatible-model timed out after 100ms of inactivity.",
      ),
    );
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
      const response = await fetchOpenAICompatibleWithRetries(
        `http://127.0.0.1:${server.port}`,
        {},
        1,
        (details) => retries.push(details),
      );

      expect(await response.text()).toBe("ok");
      expect(requestCount).toBe(2);
      expect(retries).toEqual([
        {
          attempt: 1,
          delayMs: 0,
          errorCode: "PROVIDER_HTTP_ERROR",
          errorType: "OpenAICompatibleHttpError",
          httpStatus: 429,
        },
      ]);
    } finally {
      server.stop(true);
    }
  });
});

function createConfig(
  overrides: Partial<OpenAICompatibleModelConfig> = {},
): OpenAICompatibleModelConfig {
  return {
    provider: "compatible",
    model: "compatible-model",
    baseUrl: "https://example.com/v1",
    metadata: {
      contextWindow: 32_768,
      maxOutputTokens: 8_192,
      supportsParallelToolCalls: true,
      supportsHostedWebSearch: false,
    },
    ...overrides,
  };
}
