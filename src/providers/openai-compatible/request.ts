import type { AssistantContent, Message, ModelContext, ToolCallContent, ToolSpec } from "@/core";
import type { OpenAICompatibleModelConfig } from "./types";

export function buildOpenAICompatibleRequest(
  context: ModelContext,
  config: OpenAICompatibleModelConfig,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: config.model,
    messages: toMessages(context, config.metadata.supportsImageInput === true),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };

  const maxTokens = context.maxOutputTokens ?? config.maxTokens;
  if (maxTokens !== undefined) {
    request.max_tokens = maxTokens;
  }
  if (context.tools?.length) {
    request.tools = context.tools.map(toTool);
    request.tool_choice = "auto";
    if (context.parallelToolCalls !== undefined) {
      request.parallel_tool_calls = context.parallelToolCalls;
    }
  }

  return request;
}

function toMessages(
  context: ModelContext,
  supportsImageInput: boolean,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (context.system) {
    // The system role remains the most widely implemented instruction shape
    // across OpenAI-compatible Chat Completions endpoints.
    messages.push({ role: "system", content: context.system });
  }
  for (const message of context.messages) {
    messages.push(toMessage(message, supportsImageInput));
  }
  return messages;
}

function toMessage(message: Message, supportsImageInput: boolean): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: toUserContent(message.content, message.images ?? [], supportsImageInput),
      };
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    case "assistant":
      return toAssistantMessage(message.content);
  }
}

function toUserContent(
  text: string,
  images: NonNullable<Extract<Message, { role: "user" }>["images"]>,
  supportsImageInput: boolean,
): string | Array<Record<string, unknown>> {
  if (images.length === 0) {
    return text;
  }
  if (!supportsImageInput) {
    const omitted = `[${images.length} image attachment(s) omitted because this model does not support image input.]`;
    return text ? `${text}\n\n${omitted}` : omitted;
  }

  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images.map((image) => ({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${image.data}`,
      },
    })),
  ];
}

function toAssistantMessage(content: AssistantContent[]): Record<string, unknown> {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = content.filter((block) => block.type === "tool_call").map(toToolCall);

  // Reasoning and hosted-tool state belong to the provider that produced them.
  // A generic Chat Completions endpoint receives only replayable visible text
  // and local function calls when a conversation changes providers.
  return {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function toToolCall(content: ToolCallContent): Record<string, unknown> {
  return {
    id: content.id,
    type: "function",
    function: {
      name: content.name,
      arguments: content.rawArgs ?? JSON.stringify(content.args),
    },
  };
}

function toTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
