import { describe, expect, test } from "bun:test";
import { buildDeepSeekRequest } from "../../../src/providers/deepseek/request";
import { messageIdentityForTest } from "../../helpers/messages";
import { responsesRequestContract } from "../responses-request-contract";

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
        webSearch: true,
        maxOutputTokens: 12_345,
      },
      {
        provider: "deepseek",
        model: "deepseek-flash",
        apiKey: "test-key",
        reasoningEffort: "max",
      },
    );

    expect(request).toMatchObject({
      model: "deepseek-flash",
      instructions: "system",
      stream: true,
      max_output_tokens: 12_345,
      reasoning: { effort: "max" },
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
        content: [{ type: "input_text", text: "question" }],
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
        status: "completed",
        content: [{ type: "output_text", text: "answer", annotations: [] }],
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
        webSearch: false,
      },
      {
        provider: "deepseek",
        model: "deepseek-flash",
        apiKey: "test-key",
        reasoningEffort: "none",
      },
    );

    expect(request.reasoning).toEqual({ effort: "none" });
    expect(request.tool_choice).toBe("auto");
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
});

responsesRequestContract("DeepSeek Responses shared input contract", (context) =>
  buildDeepSeekRequest(context, {
    provider: "deepseek",
    model: "deepseek-flash",
    apiKey: "test-key",
  }),
);
