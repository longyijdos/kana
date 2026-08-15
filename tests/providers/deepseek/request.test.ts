import { describe, expect, test } from "bun:test";
import { buildDeepSeekRequest } from "../../../src/providers/deepseek/request";
import { messageIdentityForTest } from "../../helpers/messages";

describe("buildDeepSeekRequest", () => {
  test("requests usage in streaming responses", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [
          {
            ...messageIdentityForTest("user"),
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

  test("converts image attachments into an explicit text-only fallback", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [
          {
            ...messageIdentityForTest("user"),
            role: "user",
            content: "",
            images: [
              {
                mimeType: "image/jpeg",
                data: "private-image-bytes",
                width: 32,
                height: 16,
              },
            ],
          },
        ],
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    );

    expect(request.messages).toEqual([
      {
        role: "user",
        content: "[1 image attachment(s) omitted because DeepSeek does not support image input.]",
      },
    ]);
    expect(JSON.stringify(request)).not.toContain("private-image-bytes");
  });

  test("prefers the per-request output ceiling over the configured maximum", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [{ ...messageIdentityForTest("user"), role: "user", content: "hi" }],
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
            ...messageIdentityForTest("user"),
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
