import { describe, expect, test } from "bun:test";
import type { AssistantContent } from "@/core";
import type { OpenAIResponsesModelConfig } from "../../../src/providers";
import { buildOpenAIResponsesRequest } from "../../../src/providers/openai-responses/request";
import { messageIdentityForTest } from "../../helpers/messages";
import { responsesRequestContract } from "../responses-request-contract";

const CONFIG: OpenAIResponsesModelConfig = {
  provider: "custom",
  model: "responses-model",
  baseUrl: "https://models.example.com/v1",
  metadata: {
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsParallelToolCalls: true,
    supportsHostedWebSearch: true,
    supportsImageInput: false,
  },
};

const OWNER = "custom:responses:https://models.example.com/v1#responses-model";

describe("buildOpenAIResponsesRequest", () => {
  test("serializes stateless Responses requests with function and hosted tools", () => {
    const request = buildOpenAIResponsesRequest(
      {
        system: "system",
        messages: [{ ...messageIdentityForTest("user"), role: "user", content: "question" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        webSearch: true,
        parallelToolCalls: true,
        maxOutputTokens: 2_048,
      },
      { ...CONFIG, reasoningEffort: "high" },
    );

    expect(request).toEqual({
      model: "responses-model",
      instructions: "system",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
      ],
      stream: true,
      store: false,
      max_output_tokens: 2_048,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" },
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          strict: false,
        },
        { type: "web_search" },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
  });

  test("omits optional controls that the context and model do not configure", () => {
    const request = buildOpenAIResponsesRequest(
      { messages: [{ ...messageIdentityForTest("user"), role: "user", content: "question" }] },
      CONFIG,
    );

    expect(Object.keys(request).sort()).toEqual(["input", "model", "store", "stream"]);
  });

  test("replays stored items only for the endpoint and model that produced them", () => {
    const storedContent = (provider: string): AssistantContent[] => [
      {
        type: "thinking",
        text: "summary",
        providerState: {
          provider,
          value: {
            id: "rs-1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "summary" }],
            encrypted_content: "opaque",
          },
        },
      },
      {
        type: "hosted_tool",
        id: "ws-1",
        name: "web_search",
        status: "completed",
        action: { type: "search", query: "news" },
        providerState: {
          provider,
          value: {
            id: "ws-1",
            type: "web_search_call",
            status: "completed",
            action: { type: "search", query: "news" },
          },
        },
      },
      { type: "text", text: "answer" },
    ];
    const buildInput = (provider: string) =>
      buildOpenAIResponsesRequest(
        {
          messages: [
            {
              ...messageIdentityForTest("assistant"),
              role: "assistant",
              content: storedContent(provider),
            },
          ],
        },
        CONFIG,
      ).input;
    const visibleAnswer = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    };

    expect(buildInput(OWNER)).toEqual([
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "summary" }],
        encrypted_content: "opaque",
      },
      { type: "web_search_call", status: "completed", action: { type: "search", query: "news" } },
      visibleAnswer,
    ]);
    expect(buildInput("custom:responses:https://models.example.com/v1#other-model")).toEqual([
      visibleAnswer,
    ]);
  });
});

responsesRequestContract("OpenAI Responses-compatible shared input contract", (context) =>
  buildOpenAIResponsesRequest(context, CONFIG),
);
