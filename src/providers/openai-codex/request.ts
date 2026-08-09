import type { AssistantContent, Message, ModelContext, ToolCallContent, ToolSpec } from "@/core";
import type { OpenAICodexModelConfig } from "./types";

export function buildOpenAICodexRequest(
  context: ModelContext,
  config: OpenAICodexModelConfig,
): Record<string, unknown> {
  const tools = toOpenAICodexTools(context.tools ?? []);
  if (config.webSearch !== false) {
    tools.push({ type: "web_search" });
  }

  // The ChatGPT Codex request contract does not expose max_output_tokens, so
  // configured and per-request output ceilings stay local to Kana.
  const request: Record<string, unknown> = {
    model: config.model,
    store: false,
    stream: true,
    instructions: context.system || "You are a helpful assistant.",
    input: toOpenAICodexInput(context.messages),
    text: {
      verbosity: "low",
    },
    include: ["reasoning.encrypted_content"],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: context.parallelToolCalls === true,
  };

  if (config.reasoningEffort !== undefined) {
    request.reasoning = {
      effort: config.reasoningEffort,
      summary: config.reasoningSummary ?? "auto",
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
    case "hosted_tool":
      // Provider-hosted calls can only be replayed from their opaque response
      // item; there is no client-generated equivalent.
      return [];
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
  if (
    type !== "reasoning" &&
    type !== "message" &&
    type !== "function_call" &&
    type !== "web_search_call"
  ) {
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
