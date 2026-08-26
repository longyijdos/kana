import type { AssistantContent, Message, ModelContext, ToolCallContent, ToolSpec } from "@/core";
import type { OpenAICompatibleModelConfig } from "./types";

export function buildOpenAICompatibleRequest(
  context: ModelContext,
  config: OpenAICompatibleModelConfig,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: config.model,
    messages: toMessages(
      context,
      context.imageInput === true && config.metadata.supportsImageInput === true,
    ),
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };

  const maxOutputTokens = context.maxOutputTokens ?? config.maxOutputTokens;
  if (maxOutputTokens !== undefined) {
    request.max_tokens = maxOutputTokens;
  }
  if (config.reasoningEffort !== undefined) {
    request.reasoning_effort = config.reasoningEffort;
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
  const pendingToolImageMessages: Array<Extract<Message, { role: "tool" }>> = [];
  if (context.system) {
    // The system role remains the most widely implemented instruction shape
    // across OpenAI-compatible Chat Completions endpoints.
    messages.push({ role: "system", content: context.system });
  }
  for (const message of context.messages) {
    if (message.role !== "tool") {
      appendToolImageObservation(messages, pendingToolImageMessages);
    }
    messages.push(toMessage(message, supportsImageInput));
    if (message.role === "tool" && supportsImageInput && message.images?.length) {
      pendingToolImageMessages.push(message);
    }
  }
  appendToolImageObservation(messages, pendingToolImageMessages);
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
        content: toToolContent(message, supportsImageInput),
        tool_call_id: message.toolCallId,
      };
    case "assistant":
      return toAssistantMessage(message.content);
  }
}

function toToolContent(
  message: Extract<Message, { role: "tool" }>,
  supportsImageInput: boolean,
): string {
  const imageCount = message.images?.length ?? 0;
  if (imageCount === 0 || supportsImageInput) {
    return message.content;
  }

  const omitted = `[${imageCount} tool image observation(s) omitted because this model does not support image input.]`;
  return message.content ? `${message.content}\n\n${omitted}` : omitted;
}

function appendToolImageObservation(
  messages: Array<Record<string, unknown>>,
  pending: Array<Extract<Message, { role: "tool" }>>,
): void {
  if (pending.length === 0) {
    return;
  }

  // Chat Completions tool messages cannot carry image_url content. Defer one
  // aggregated user observation until every sibling tool result is contiguous.
  messages.push({
    role: "user",
    content: pending.flatMap((message) => [
      {
        type: "text",
        text: `[Visual observation from ${message.toolName} tool call ${message.toolCallId}]`,
      },
      ...(message.images ?? []).map((image) => ({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType};base64,${image.data}`,
        },
      })),
    ]),
  });
  pending.length = 0;
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
