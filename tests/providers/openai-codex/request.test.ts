import { describe, expect, test } from "bun:test";
import { buildOpenAICodexRequest } from "../../../src/providers/openai-codex/request";
import { messageIdentityForTest } from "../../helpers/messages";

describe("buildOpenAICodexRequest", () => {
  test("uses the classic Responses contract and preserves provider replay state", () => {
    const request = buildOpenAICodexRequest(
      {
        system: "system",
        messages: [
          {
            ...messageIdentityForTest("user"),
            role: "user",
            content: "question",
            images: [
              {
                mimeType: "image/png",
                data: "aGVsbG8=",
                width: 2,
                height: 3,
              },
            ],
          },
          {
            ...messageIdentityForTest("assistant"),
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
        webSearch: true,
        imageInput: true,
        parallelToolCalls: false,
        maxOutputTokens: 12_345,
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        credentialProvider: credentials(),
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        maxOutputTokens: 32_768,
      },
    );

    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      stream: true,
      instructions: "system",
      include: ["reasoning.encrypted_content"],
      text: { verbosity: "low" },
      reasoning: {
        effort: "medium",
        summary: "auto",
      },
      tool_choice: "auto",
      parallel_tool_calls: false,
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
        { type: "web_search" },
      ],
    });
    expect(request).not.toHaveProperty("max_output_tokens");
    expect(request.reasoning).not.toHaveProperty("context");
    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "question" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
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

  test("omits only the hosted web search tool when disabled", () => {
    const request = buildOpenAICodexRequest(
      {
        messages: [],
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
        webSearch: false,
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        credentialProvider: credentials(),
      },
    );

    expect(request).toMatchObject({
      instructions: "You are a helpful assistant.",
      input: [],
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
    });
    expect(request.tools).not.toContainEqual({ type: "web_search" });
    expect(request.input).not.toContainEqual({
      type: "additional_tools",
      role: "developer",
      tools: expect.anything(),
    });
  });

  test("keeps disabled image attachments explicit without transmitting their bytes", () => {
    const request = buildOpenAICodexRequest(
      {
        messages: [
          {
            ...messageIdentityForTest("user"),
            role: "user",
            content: "Inspect this.",
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
        imageInput: false,
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        credentialProvider: credentials(),
      },
    );

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this." },
          {
            type: "input_text",
            text: "[1 image attachment(s) omitted because image input is disabled.]",
          },
        ],
      },
    ]);
    expect(JSON.stringify(request)).not.toContain("private-image-bytes");
  });

  test("encodes tool image observations as native multimodal function outputs", () => {
    const context = {
      messages: [
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant" as const,
          content: [
            {
              type: "tool_call" as const,
              id: "call-view",
              name: "view_image",
              args: { path: "screen.png" },
            },
          ],
        },
        {
          ...messageIdentityForTest("tool"),
          role: "tool" as const,
          toolCallId: "call-view",
          toolName: "view_image",
          content: "Viewed screen.png",
          images: [
            {
              mimeType: "image/png" as const,
              data: "tool-image-bytes",
              width: 32,
              height: 16,
            },
          ],
          isError: false,
        },
      ],
    };
    const config = {
      provider: "openai-codex" as const,
      model: "gpt-5.6-luna" as const,
      credentialProvider: credentials(),
    };

    const enabled = buildOpenAICodexRequest({ ...context, imageInput: true }, config);
    const disabled = buildOpenAICodexRequest({ ...context, imageInput: false }, config);

    expect(enabled.input).toEqual([
      {
        type: "function_call",
        call_id: "call-view",
        name: "view_image",
        arguments: '{"path":"screen.png"}',
      },
      {
        type: "function_call_output",
        call_id: "call-view",
        output: [
          { type: "input_text", text: "Viewed screen.png" },
          { type: "input_image", image_url: "data:image/png;base64,tool-image-bytes" },
        ],
      },
    ]);
    expect(disabled.input).toEqual([
      {
        type: "function_call",
        call_id: "call-view",
        name: "view_image",
        arguments: '{"path":"screen.png"}',
      },
      {
        type: "function_call_output",
        call_id: "call-view",
        output:
          "Viewed screen.png\n\n[1 tool image observation(s) omitted because image input is disabled.]",
      },
    ]);
    expect(JSON.stringify(disabled)).not.toContain("tool-image-bytes");
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
