import { describe, expect, test } from "bun:test";
import { buildDeepSeekRequest } from "../../../src/providers/deepseek/request";

describe("buildDeepSeekRequest", () => {
  test("requests usage in streaming responses", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [
          {
            role: "user",
            content: "hi",
          },
        ],
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    );

    expect(request).toMatchObject({
      stream: true,
      stream_options: {
        include_usage: true,
      },
    });
  });

  test("prefers the per-request output ceiling over the configured maximum", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 12_345,
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        maxTokens: 384_000,
      },
    );

    expect(request.max_tokens).toBe(12_345);
  });

  test("omits reasoning_effort when thinking is disabled", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [
          {
            role: "user",
            content: "hi",
          },
        ],
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: false,
        reasoningEffort: "high",
      },
    );

    expect(request).toMatchObject({
      thinking: {
        type: "disabled",
      },
    });
    expect(request).not.toHaveProperty("reasoning_effort");
  });
});
