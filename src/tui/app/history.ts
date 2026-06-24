import type { AssistantMessage, Message, ToolCallContent } from "@/core";
import { AssistantMessageBlock, TextBlock, ToolCallBlock, type Transcript } from "../components";
import { tuiTheme } from "../theme";

export function addHistoryMessagesToTranscript(transcript: Transcript, messages: Message[]): void {
  const toolCalls = new Map<string, ToolCallContent>();

  for (const message of messages) {
    switch (message.role) {
      case "user":
        transcript.addChild(
          new TextBlock(formatUserMessage(message), {
            color: message.source === "scheduled" ? tuiTheme.muted : tuiTheme.user,
            prefix: message.source === "scheduled" ? "" : "> ",
          }),
        );
        break;

      case "assistant":
        addAssistantMessage(transcript, message, toolCalls);
        break;

      case "tool":
        addToolResult(transcript, message, toolCalls);
        break;
    }
  }
}

function formatUserMessage(message: Extract<Message, { role: "user" }>): string {
  if (message.source !== "scheduled") {
    return message.content;
  }

  const content = message.content.replace(/^\[Scheduled wake event\]\n?/, "");
  return `Scheduled wake: ${content}`;
}

function addAssistantMessage(
  transcript: Transcript,
  message: AssistantMessage,
  toolCalls: Map<string, ToolCallContent>,
): void {
  const block = new AssistantMessageBlock();
  block.update(message);
  block.showThinking(false);
  transcript.addChild(block);

  for (const content of message.content) {
    if (content.type === "tool_call") {
      toolCalls.set(content.id, structuredClone(content));
    }
  }
}

function addToolResult(
  transcript: Transcript,
  message: Extract<Message, { role: "tool" }>,
  toolCalls: Map<string, ToolCallContent>,
): void {
  const block = new ToolCallBlock(
    toolCalls.get(message.toolCallId) ?? {
      type: "tool_call",
      id: message.toolCallId,
      name: message.toolName,
      args: undefined,
    },
  );

  block.updateResult(message.result ?? message.content, message.isError);
  transcript.addChild(block);
}
