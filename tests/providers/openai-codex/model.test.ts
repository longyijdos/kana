import { describe, expect, test } from "bun:test";
import { OpenAICodexModel } from "../../../src/providers/openai-codex/model";

describe("OpenAI Codex model", () => {
  test("refreshes once after a 401 and streams the retried response", async () => {
    const authorizationHeaders: string[] = [];
    const accountHeaders: string[] = [];
    const requests: Record<string, unknown>[] = [];
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
      fetch: (async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorizationHeaders.push(headers.get("authorization") ?? "");
        accountHeaders.push(headers.get("chatgpt-account-id") ?? "");
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
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    expect(refreshCount).toBe(1);
    expect(authorizationHeaders).toEqual(["Bearer expired-token", "Bearer refreshed-token"]);
    expect(accountHeaders).toEqual(["account-id", "account-id"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
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
  });
});

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
