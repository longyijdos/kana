import { describe, expect, test } from "bun:test";
import { buildDeepSeekRequest } from "../src/providers/deepseek/request";

describe("buildDeepSeekRequest", () => {
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
