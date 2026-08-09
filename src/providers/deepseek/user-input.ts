import type { UserMessage } from "@/core";

export function toDeepSeekUserText(message: UserMessage): string {
  const imageCount = message.images?.length ?? 0;
  if (imageCount === 0) {
    return message.content;
  }

  // DeepSeek V4 currently accepts text input only. Preserve image attachments
  // in Kana's session for future providers, but make the degraded replay
  // visible to this model instead of silently discarding visual context.
  const omitted = `[${imageCount} image attachment(s) omitted because DeepSeek does not support image input.]`;
  return message.content ? `${message.content}\n\n${omitted}` : omitted;
}
