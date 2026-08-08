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
              {
                type: "hosted_tool",
                id: "web-search-id",
                name: "web_search",
                status: "completed",
                action: {
                  type: "search",
                  query: "current release",
                  queries: ["current release"],
                },
                providerState: {
                  provider: "openai-codex",
                  value: {
                    id: "web-search-id",
                    type: "web_search_call",
                    status: "completed",
                    action: {
                      type: "search",
                      query: "current release",
                      queries: ["current release"],
                    },
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
      tools: [{ type: "web_search" }],
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
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "current release",
          queries: ["current release"],
        },
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
      },
    ]);
  });

  test("omits the hosted web search tool when disabled", () => {
    const request = buildOpenAICodexRequest(
      {
        messages: [],
        tools: [],
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        credentialProvider: credentials(),
        webSearch: false,
      },
    );

    expect(request).not.toHaveProperty("tools");
    expect(request.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "You are a helpful assistant." }],
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
