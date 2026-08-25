import { describe, expect, test } from "bun:test";
import { buildOpenAICompatibleRequest } from "../../../src/providers/openai-compatible/request";
import type { OpenAICompatibleModelConfig } from "../../../src/providers/openai-compatible/types";
import { messageIdentityForTest } from "../../helpers/messages";

describe("buildOpenAICompatibleRequest", () => {
  test("builds a streaming Chat Completions request with tools", () => {
    const request = buildOpenAICompatibleRequest(
      {
        system: "system",
        messages: [
          { ...messageIdentityForTest("user"), role: "user", content: "question" },
          {
            ...messageIdentityForTest("assistant"),
            role: "assistant",
            content: [
              { type: "thinking", text: "provider reasoning" },
              { type: "text", text: "answer" },
              {
                type: "tool_call",
                id: "call-1",
                name: "read",
                args: { path: "a.ts" },
                rawArgs: '{"path":"a.ts"}',
              },
              {
                type: "hosted_tool",
                id: "search-1",
                name: "web_search",
                status: "completed",
                action: { type: "search", query: "release" },
              },
            ],
          },
          {
            ...messageIdentityForTest("tool"),
            role: "tool",
            toolCallId: "call-1",
            toolName: "read",
            content: "source",
            isError: false,
          },
        ],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        parallelToolCalls: true,
        maxOutputTokens: 12_345,
      },
      createConfig({ reasoningEffort: "high" }),
    );

    expect(request).toEqual({
      model: "compatible-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: "answer",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: "tool", content: "source", tool_call_id: "call-1" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 12_345,
      reasoning_effort: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
  });

  test("uses configured max tokens when the turn has no tighter ceiling", () => {
    const request = buildOpenAICompatibleRequest(
      { messages: [] },
      createConfig({ maxOutputTokens: 4_096 }),
    );

    expect(request.max_tokens).toBe(4_096);
  });

  test("sends data URLs only when image input is supported", () => {
    const message = {
      ...messageIdentityForTest("user"),
      role: "user" as const,
      content: "describe",
      images: [
        {
          mimeType: "image/png" as const,
          data: "private-image-bytes",
          width: 32,
          height: 16,
        },
      ],
    };

    const supported = buildOpenAICompatibleRequest({ messages: [message] }, createConfig({}, true));
    const unsupported = buildOpenAICompatibleRequest({ messages: [message] }, createConfig());

    expect(supported.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,private-image-bytes" },
          },
        ],
      },
    ]);
    expect(unsupported.messages).toEqual([
      {
        role: "user",
        content:
          "describe\n\n[1 image attachment(s) omitted because this model does not support image input.]",
      },
    ]);
    expect(JSON.stringify(unsupported)).not.toContain("private-image-bytes");
  });

  test("emits tool images after contiguous sibling results as one user observation", () => {
    const messages = [
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
          {
            type: "tool_call" as const,
            id: "call-read",
            name: "read",
            args: { path: "notes.txt" },
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
      {
        ...messageIdentityForTest("tool"),
        role: "tool" as const,
        toolCallId: "call-read",
        toolName: "read",
        content: "notes",
        isError: false,
      },
    ];

    const supported = buildOpenAICompatibleRequest({ messages }, createConfig({}, true));
    const unsupported = buildOpenAICompatibleRequest({ messages }, createConfig());
    if (!Array.isArray(unsupported.messages)) {
      throw new Error("Expected Chat Completions messages.");
    }

    expect(supported.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-view",
            type: "function",
            function: { name: "view_image", arguments: '{"path":"screen.png"}' },
          },
          {
            id: "call-read",
            type: "function",
            function: { name: "read", arguments: '{"path":"notes.txt"}' },
          },
        ],
      },
      { role: "tool", content: "Viewed screen.png", tool_call_id: "call-view" },
      { role: "tool", content: "notes", tool_call_id: "call-read" },
      {
        role: "user",
        content: [
          { type: "text", text: "[Visual observation from view_image tool call call-view]" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,tool-image-bytes" },
          },
        ],
      },
    ]);
    expect(unsupported.messages[1]).toEqual({
      role: "tool",
      content:
        "Viewed screen.png\n\n[1 tool image observation(s) omitted because this model does not support image input.]",
      tool_call_id: "call-view",
    });
    expect(unsupported.messages).toHaveLength(3);
    expect(JSON.stringify(unsupported)).not.toContain("tool-image-bytes");
  });
});

function createConfig(
  overrides: Partial<OpenAICompatibleModelConfig> = {},
  supportsImageInput = false,
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
      supportsImageInput,
    },
    ...overrides,
  };
}
