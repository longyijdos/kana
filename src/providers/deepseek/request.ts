import type { AssistantContent, Message, ModelContext, ToolCallContent, ToolSpec } from "@/core";
import { getDeepSeekModelMetadata } from "./metadata";
import type { DeepSeekModelConfig, DeepSeekToolChoice } from "./types";

export function buildDeepSeekRequest(
  context: ModelContext,
  config: DeepSeekModelConfig,
): Record<string, unknown> {
  const tools = toDeepSeekResponsesTools(context.tools ?? [], config.strictTools ?? false);
  if (config.webSearch !== false) {
    tools.push({ type: "web_search" });
  }

  const imageInputEnabled =
    getDeepSeekModelMetadata(config.model).supportsImageInput === true &&
    config.imageInput !== false;

  const request: Record<string, unknown> = {
    model: config.model,
    instructions: context.system || "You are a helpful assistant.",
    input: toDeepSeekResponsesInput(context.messages, imageInputEnabled),
    stream: true,
  };

  if (config.temperature !== undefined) {
    request.temperature = config.temperature;
  }

  const maxOutputTokens = context.maxOutputTokens ?? config.maxTokens;
  if (maxOutputTokens !== undefined) {
    request.max_output_tokens = maxOutputTokens;
  }

  if (config.topP !== undefined) {
    request.top_p = config.topP;
  }

  if (config.reasoningEffort !== undefined) {
    request.reasoning = { effort: config.reasoningEffort };
  }

  if (config.responseFormat !== undefined) {
    request.text = { format: config.responseFormat };
  }

  if (config.userId !== undefined) {
    request.user = config.userId;
  }

  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = toDeepSeekResponsesToolChoice(config.toolChoice ?? "auto");
  } else if (config.toolChoice !== undefined) {
    request.tool_choice = toDeepSeekResponsesToolChoice(config.toolChoice);
  }

  return request;
}

function toDeepSeekResponsesInput(
  messages: Message[],
  imageInputEnabled: boolean,
): Record<string, unknown>[] {
  return messages.flatMap((message) => toDeepSeekResponsesMessage(message, imageInputEnabled));
}

function toDeepSeekResponsesMessage(
  message: Message,
  imageInputEnabled: boolean,
): Record<string, unknown>[] {
  switch (message.role) {
    case "user":
      return [
        {
          type: "message",
          role: "user",
          content: toDeepSeekUserContent(message, imageInputEnabled),
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
      return message.content.flatMap(toDeepSeekResponsesAssistantContent);
  }
}

function toDeepSeekUserContent(
  message: Extract<Message, { role: "user" }>,
  imageInputEnabled: boolean,
): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];

  if (message.content) {
    content.push({ type: "input_text", text: message.content });
  }

  if (imageInputEnabled) {
    for (const image of message.images ?? []) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${image.data}`,
      });
    }
  } else if (message.images?.length) {
    // Keep cross-configuration session replay explicit without transmitting
    // image bytes after image input is unavailable or disabled.
    content.push({
      type: "input_text",
      text: `[${message.images.length} image attachment(s) omitted because image input is disabled.]`,
    });
  }

  return content;
}

function toDeepSeekResponsesAssistantContent(content: AssistantContent): Record<string, unknown>[] {
  const responseItem = readDeepSeekResponseItem(content);
  if (responseItem !== undefined) {
    // DeepSeek Responses is stateless and documents completed output items as
    // replayable input, including web searches whose results it reconstructs.
    return [structuredClone(responseItem)];
  }

  switch (content.type) {
    case "thinking":
      return [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: content.text }],
        },
      ];
    case "text":
      return [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: content.text }],
        },
      ];
    case "tool_call":
      return [toDeepSeekResponsesFunctionCall(content)];
    case "hosted_tool":
      // Hosted calls from another provider cannot be reconstructed locally.
      return [];
  }
}

function readDeepSeekResponseItem(content: AssistantContent): Record<string, unknown> | undefined {
  const state = content.providerState;
  if (state?.provider !== "deepseek" || !isRecord(state.value)) {
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
  return state.value;
}

function toDeepSeekResponsesFunctionCall(content: ToolCallContent): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: content.id,
    name: content.name,
    arguments: content.rawArgs ?? JSON.stringify(content.args),
  };
}

function toDeepSeekResponsesTools(tools: ToolSpec[], strict: boolean): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(strict ? { strict: true } : {}),
  }));
}

function toDeepSeekResponsesToolChoice(
  choice: DeepSeekToolChoice,
): string | Record<string, unknown> {
  if (typeof choice === "string") {
    return choice;
  }
  return {
    type: "function",
    name: choice.function.name,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
