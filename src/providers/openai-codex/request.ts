import type { AssistantContent, Message, ModelContext, ToolCallContent } from "@/core";
import type { ToolSpec } from "@/tools";
import type { OpenAICodexModelConfig } from "./types";

export function buildOpenAICodexRequest(
  context: ModelContext,
  config: OpenAICodexModelConfig,
): Record<string, unknown> {
  const tools = toOpenAICodexTools(context.tools ?? []);
  const input: Record<string, unknown>[] = [
    // GPT-5.6 Codex models use the Responses Lite contract: client tools and
    // instructions are input items rather than top-level request fields.
    {
      type: "additional_tools",
      role: "developer",
      tools,
    },
    {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: context.system || "You are a helpful assistant.",
        },
      ],
    },
    ...toOpenAICodexInput(context.messages),
  ];
  // The Codex backend rejects max_output_tokens, so maxTokens remains Kana's
  // local context-compaction output reserve and is intentionally omitted here.
  const request: Record<string, unknown> = {
    model: config.model,
    store: false,
    stream: true,
    input,
    text: {
      verbosity: "low",
    },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: false,
  };

  if (config.reasoningEffort !== undefined) {
    request.reasoning = {
      effort: config.reasoningEffort,
      summary: config.reasoningSummary ?? "auto",
      context: "all_turns",
    };
  }

  return request;
}

function toOpenAICodexInput(messages: Message[]): Record<string, unknown>[] {
  return messages.flatMap(toOpenAICodexMessage);
}

function toOpenAICodexMessage(message: Message): Record<string, unknown>[] {
  switch (message.role) {
    case "user":
      return [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: message.content }],
        },
      ];
    case "tool":
      return [
        {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        },
      ];
    case "assistant":
      return message.content.flatMap(toOpenAICodexAssistantContent);
  }
}

function toOpenAICodexAssistantContent(content: AssistantContent): Record<string, unknown>[] {
  const responseItem = readOpenAICodexResponseItem(content);
  if (responseItem !== undefined) {
    return [structuredClone(responseItem)];
  }

  switch (content.type) {
    case "thinking":
      // Reasoning text is only a user-facing summary. Without the provider's
      // opaque reasoning item it must not be reconstructed as model input.
      return [];
    case "text":
      return [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: content.text, annotations: [] }],
        },
      ];
    case "tool_call":
      return [toOpenAICodexFunctionCall(content)];
  }
}

function toOpenAICodexFunctionCall(content: ToolCallContent): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: content.id,
    name: content.name,
    arguments: content.rawArgs ?? JSON.stringify(content.args),
  };
}

function readOpenAICodexResponseItem(
  content: AssistantContent,
): Record<string, unknown> | undefined {
  const state = content.providerState;
  if (state?.provider !== "openai-codex" || !isRecord(state.value)) {
    return undefined;
  }
  const type = state.value.type;
  if (type !== "reasoning" && type !== "message" && type !== "function_call") {
    return undefined;
  }
  // store=false means response item IDs must not reference server-side state.
  const item = structuredClone(state.value);
  delete item.id;
  return item;
}

function toOpenAICodexTools(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
