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
    input: toOpenAICodexInput(context.messages, config),
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

function toOpenAICodexInput(
  messages: Message[],
  config: OpenAICodexModelConfig,
): Record<string, unknown>[] {
  return messages.flatMap((message) => toOpenAICodexMessage(message, config));
}

function toOpenAICodexMessage(
  message: Message,
  config: OpenAICodexModelConfig,
): Record<string, unknown>[] {
  switch (message.role) {
    case "user":
      return [
        {
          type: "message",
          role: "user",
          content: toOpenAICodexUserContent(message, config),
        },
      ];
    case "tool":
      return [
        {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: toOpenAICodexToolOutput(message, config.imageInput !== false),
        },
      ];
    case "assistant":
      return message.content.flatMap(toOpenAICodexAssistantContent);
  }
}

function toOpenAICodexToolOutput(
  message: Extract<Message, { role: "tool" }>,
  imageInputEnabled: boolean,
): string | Record<string, unknown>[] {
  const images = message.images ?? [];
  if (images.length === 0) {
    return message.content;
  }
  if (!imageInputEnabled) {
    return appendImageOmission(message.content, images.length);
  }

  // Responses function outputs natively accept input content blocks, keeping
  // the visual observation associated with the function call that produced it.
  return [
    ...(message.content ? [{ type: "input_text", text: message.content }] : []),
    ...images.map((image) => ({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];
}

function toOpenAICodexUserContent(
  message: Extract<Message, { role: "user" }>,
  config: OpenAICodexModelConfig,
): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];

  if (message.content) {
    content.push({ type: "input_text", text: message.content });
  }

  if (config.imageInput !== false) {
    for (const image of message.images ?? []) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${image.data}`,
      });
    }
  } else if (message.images?.length) {
    // Keep cross-configuration session replay explicit without transmitting
    // image bytes after the user disables image input.
    content.push({
      type: "input_text",
      text: `[${message.images.length} image attachment(s) omitted because image input is disabled.]`,
    });
  }

  return content;
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

function appendImageOmission(content: string, imageCount: number): string {
  const omitted = `[${imageCount} tool image observation(s) omitted because image input is disabled.]`;
  return content ? `${content}\n\n${omitted}` : omitted;
}
