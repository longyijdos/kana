import { describe, expect, test } from "bun:test";
import { buildOpenAICodexRequest } from "../../../src/providers/openai-codex/request";

describe("buildOpenAICodexRequest", () => {
  test("uses the Responses Lite contract and preserves provider replay state", () => {
    const request = buildOpenAICodexRequest(
      {
        system: "system",
        messages: [
          { role: "user", content: "question" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                text: "summary",
                providerState: {
                  provider: "openai-codex",
                  value: {
                    id: "reasoning-id",
                    type: "reasoning",
                    encrypted_content: "opaque",
                    summary: [{ type: "summary_text", text: "summary" }],
                  },
                },
              },
              { type: "text", text: "answer" },
            ],
          },
        ],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        parallelToolCalls: false,
        maxOutputTokens: 12_345,
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        credentialProvider: credentials(),
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        maxTokens: 32_768,
      },
    );

    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      text: { verbosity: "low" },
      reasoning: {
        effort: "medium",
        summary: "auto",
        context: "all_turns",
      },
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(request).not.toHaveProperty("max_output_tokens");
    expect(request.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "question" }],
      },
      {
        type: "reasoning",
        encrypted_content: "opaque",
        summary: [{ type: "summary_text", text: "summary" }],
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
    ]);
  });
});

function credentials() {
  return {
    async getCredentials() {
      return { accessToken: "access-token", accountId: "account-id" };
    },
    async refreshCredentials() {
      return { accessToken: "access-token", accountId: "account-id" };
    },
  };
}
