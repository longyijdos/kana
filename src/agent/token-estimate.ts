import type { HostedToolContent, Message, ModelContext, ToolCallContent, UserImage } from "@/core";

// Local estimates use roughly three UTF-8 bytes per token. Provider usage
// replaces them whenever a measured prompt is available.
export function estimateContextTokens(context: ModelContext): number {
  return (
    8 +
    estimateTextTokens(context.system ?? "") +
    estimateTextTokens(
      context.tools
        ? stringifyForEstimate(
            context.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          )
        : "",
    ) +
    estimateMessagesTokens(context.messages)
  );
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: Message): number {
  switch (message.role) {
    case "user":
      return 6 + estimateTextTokens(message.content) + estimateImageTokens(message.images);
    case "tool":
      return (
        10 +
        estimateTextTokens(message.toolName) +
        estimateTextTokens(message.toolCallId) +
        estimateTextTokens(message.content) +
        estimateImageTokens(message.images)
      );
    case "assistant":
      return (
        8 +
        message.content.reduce((total, content) => {
          switch (content.type) {
            case "text":
            case "thinking":
              return total + 4 + estimateTextTokens(content.text);
            case "tool_call":
              return total + estimateToolCallTokens(content);
            case "hosted_tool":
              return total + estimateHostedToolTokens(content);
          }
          return total;
        }, 0)
      );
  }
}

function estimateImageTokens(images: readonly UserImage[] | undefined): number {
  // Current Codex models use 32px image patches at original/auto detail. Keep
  // base64 bytes out of token estimation because they are not textual input.
  return (images ?? []).reduce(
    (total, image) => total + Math.ceil(image.width / 32) * Math.ceil(image.height / 32),
    0,
  );
}

function estimateHostedToolTokens(content: HostedToolContent): number {
  return (
    8 + estimateTextTokens(content.name) + estimateTextTokens(stringifyForEstimate(content.action))
  );
}

function estimateToolCallTokens(content: ToolCallContent): number {
  return (
    10 +
    estimateTextTokens(content.name) +
    estimateTextTokens(content.rawArgs ?? stringifyForEstimate(content.args))
  );
}

function stringifyForEstimate(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}
