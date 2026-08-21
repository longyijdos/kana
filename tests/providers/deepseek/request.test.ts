import { describe, expect, test } from "bun:test";
import { buildDeepSeekRequest } from "../../../src/providers/deepseek/request";
import { messageIdentityForTest } from "../../helpers/messages";

describe("buildDeepSeekRequest", () => {
  test("uses the Responses contract and preserves DeepSeek output items for stateless replay", () => {
    const request = buildDeepSeekRequest(
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
                data: "private-image-bytes",
                width: 32,
                height: 16,
              },
            ],
          },
          {
            ...messageIdentityForTest("assistant"),
            role: "assistant",
            content: [
              {
                type: "thinking",
                text: "reasoning",
                providerState: {
                  provider: "deepseek",
                  value: {
                    id: "reasoning-1",
                    type: "reasoning",
                    status: "completed",
                    content: [{ type: "reasoning_text", text: "reasoning" }],
                  },
                },
              },
              {
                type: "hosted_tool",
                id: "search-1",
                name: "web_search",
                status: "completed",
                action: { type: "search", query: "latest release" },
                providerState: {
                  provider: "deepseek",
                  value: {
                    id: "search-1",
                    type: "web_search_call",
                    status: "completed",
                    action: { type: "search", query: "latest release" },
                  },
                },
              },
              { type: "text", text: "answer" },
              {
                type: "tool_call",
                id: "call-1",
                name: "read",
                args: { path: "a.ts" },
                rawArgs: '{"path":"a.ts"}',
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
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        maxOutputTokens: 12_345,
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
        webSearch: true,
        maxTokens: 32_768,
        responseFormat: { type: "json_object" },
        userId: "kana-user",
        strictTools: true,
      },
    );

    expect(request).toMatchObject({
      model: "deepseek-v4-flash",
      instructions: "system",
      stream: true,
      max_output_tokens: 12_345,
      reasoning: { effort: "max" },
      text: { format: { type: "json_object" } },
      user: "kana-user",
      tool_choice: "auto",
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
          strict: true,
        },
        { type: "web_search" },
      ],
    });
    expect(request).not.toHaveProperty("store");
    expect(request).not.toHaveProperty("stream_options");
    expect(request).not.toHaveProperty("parallel_tool_calls");
    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "question" },
          {
            type: "input_text",
            text: "[1 image attachment(s) omitted because image input is disabled.]",
          },
        ],
      },
      {
        id: "reasoning-1",
        type: "reasoning",
        status: "completed",
        content: [{ type: "reasoning_text", text: "reasoning" }],
      },
      {
        id: "search-1",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "latest release" },
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read",
        arguments: '{"path":"a.ts"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "source",
      },
    ]);
    expect(JSON.stringify(request)).not.toContain("private-image-bytes");
  });

  test("uses none reasoning and disables hosted search without removing client function tools", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [
          {
            ...messageIdentityForTest("assistant"),
            role: "assistant",
            content: [{ type: "thinking", text: "chat-completions reasoning" }],
          },
        ],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        reasoningEffort: "none",
        webSearch: false,
        toolChoice: { type: "function", function: { name: "read" } },
      },
    );

    expect(request.reasoning).toEqual({ effort: "none" });
    expect(request.tool_choice).toEqual({ type: "function", name: "read" });
    expect(request.tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(request.input).toEqual([
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "chat-completions reasoning" }],
      },
    ]);
  });

  test("sends image attachments as input_image for the vision model", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [
          {
            ...messageIdentityForTest("user"),
            role: "user",
            content: "What is in this screenshot?",
            images: [
              {
                mimeType: "image/png",
                data: "base64-image-bytes",
                width: 32,
                height: 16,
              },
            ],
          },
        ],
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash-vision-exp",
      },
    );

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is in this screenshot?" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,base64-image-bytes",
          },
        ],
      },
    ]);
  });

  test("keeps disabled image attachments explicit for the vision model without transmitting their bytes", () => {
    const request = buildDeepSeekRequest(
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
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-flash-vision-exp",
        imageInput: false,
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

  test("never sends images for text-only models even when image input is enabled", () => {
    const request = buildDeepSeekRequest(
      {
        messages: [
          {
            ...messageIdentityForTest("user"),
            role: "user",
            content: "question",
            images: [
              {
                mimeType: "image/png",
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
        model: "deepseek-v4-flash",
        imageInput: true,
      },
    );

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "question" },
          {
            type: "input_text",
            text: "[1 image attachment(s) omitted because image input is disabled.]",
          },
        ],
      },
    ]);
    expect(JSON.stringify(request)).not.toContain("private-image-bytes");
  });
});
