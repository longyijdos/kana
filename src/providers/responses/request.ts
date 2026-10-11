import type { AssistantContent, Message, ToolCallContent, ToolSpec, UserImage } from "@/core";
import { isRecord } from "@/utils";

export type ResponsesInputOptions = {
  // providerState owner whose stored items can be replayed verbatim.
  provider: string;
  imageInput: boolean;
  // Rebuild reasoning items from visible text when no opaque item exists.
  // Providers that only expose a summary must not receive it as reasoning.
  replayReasoningText: boolean;
  // With server-side storage disabled, replayed items cannot reference IDs.
  stateless?: boolean;
  namespace?: string;
};

const REPLAYABLE_ITEM_TYPES = new Set(["reasoning", "message", "function_call", "web_search_call"]);

export function toResponsesInput(
  messages: readonly Message[],
  options: ResponsesInputOptions,
): Record<string, unknown>[] {
  return messages.flatMap((message) => toInputItems(message, options));
}

function toInputItems(message: Message, options: ResponsesInputOptions): Record<string, unknown>[] {
  switch (message.role) {
    case "user":
      return [
        {
          type: "message",
          role: "user",
          content: toInputContent(
            message.content,
            message.images,
            options.imageInput,
            "image attachment(s)",
          ),
        },
      ];
    case "tool":
      return [
        {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: toToolOutput(message, options.imageInput),
        },
      ];
    case "assistant":
      return message.content.flatMap((content) => toAssistantItems(content, options));
  }
}

export function toResponsesTools(
  tools: readonly ToolSpec[],
  options: { strict?: boolean; namespace?: string },
): Record<string, unknown>[] {
  const functions = tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
  }));
  if (options.namespace === undefined || functions.length === 0) {
    return functions;
  }
  return [
    {
      type: "namespace",
      name: options.namespace,
      description: "Tools executed by Kana on the user's machine.",
      tools: functions,
    },
  ];
}

function toAssistantItems(
  content: AssistantContent,
  options: ResponsesInputOptions,
): Record<string, unknown>[] {
  const stored = content.providerState;
  if (
    stored?.provider === options.provider &&
    isRecord(stored.value) &&
    REPLAYABLE_ITEM_TYPES.has(String(stored.value.type))
  ) {
    const { id: _id, ...item } = stored.value;
    return [
      {
        ...(options.stateless ? item : stored.value),
        ...(item.type === "function_call" && options.namespace
          ? { namespace: options.namespace }
          : {}),
      },
    ];
  }

  switch (content.type) {
    case "thinking":
      return options.replayReasoningText
        ? [{ type: "reasoning", content: [{ type: "reasoning_text", text: content.text }] }]
        : [];
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
      return [toFunctionCall(content, options.namespace)];
    case "hosted_tool":
      // A hosted call can only be replayed from the provider's own item.
      return [];
  }
}

function toFunctionCall(content: ToolCallContent, namespace?: string): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: content.id,
    name: content.name,
    ...(namespace ? { namespace } : {}),
    arguments: content.rawArgs ?? JSON.stringify(content.args),
  };
}

function toToolOutput(
  message: Extract<Message, { role: "tool" }>,
  imageInput: boolean,
): string | Record<string, unknown>[] {
  if (!message.images?.length) {
    return message.content;
  }
  // Function outputs accept the same content blocks as user input, keeping a
  // visual observation attached to the call that produced it.
  const content = toInputContent(
    message.content,
    message.images,
    imageInput,
    "tool image observation(s)",
  );
  return imageInput ? content : content.map((block) => String(block.text)).join("\n\n");
}

function toInputContent(
  text: string,
  images: readonly UserImage[] | undefined,
  imageInput: boolean,
  imageLabel: string,
): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = text ? [{ type: "input_text", text }] : [];
  if (!images?.length) {
    return content;
  }
  if (!imageInput) {
    // Session replay stays explicit without transmitting image bytes once
    // image input is unavailable.
    return [
      ...content,
      {
        type: "input_text",
        text: `[${images.length} ${imageLabel} omitted because image input is disabled.]`,
      },
    ];
  }
  return [
    ...content,
    ...images.map((image) => ({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];
}
