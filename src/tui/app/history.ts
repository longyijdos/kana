import type { AssistantMessage, Message, ToolCallContent } from "@/core";
import type { KanaSessionTimelineEntry } from "@/kana";
import {
  AssistantMessageBlock,
  TextBlock,
  ToolCallBlock,
  type Transcript,
  UserMessageBlock,
} from "../components";
import { tuiTheme } from "../theme";

export function addHistoryTimelineToTranscript(
  transcript: Transcript,
  timeline: KanaSessionTimelineEntry[],
  options: { hyperlinks?: boolean; renderLatex?: boolean; renderMermaid?: boolean } = {},
): void {
  const toolCalls = new Map<string, ToolCallContent>();

  for (const entry of timeline) {
    switch (entry.type) {
      case "message":
        addHistoryMessage(transcript, entry.message, toolCalls, options);
        break;
      case "context_compaction":
        transcript.addChild(
          new TextBlock(formatContextCompaction(entry.beforeTokens, entry.estimatedAfterTokens), {
            color: tuiTheme.muted,
          }),
        );
        break;
      case "turn_start":
      case "turn_end":
        break;
    }
  }
}

function addHistoryMessage(
  transcript: Transcript,
  message: Message,
  toolCalls: Map<string, ToolCallContent>,
  options: { hyperlinks?: boolean; renderLatex?: boolean; renderMermaid?: boolean },
): void {
  switch (message.role) {
    case "user":
      if (
        message.provenance.kind === "runtime_context" ||
        message.provenance.kind === "tool_result_policy"
      ) {
        break;
      }
      transcript.addChild(
        message.provenance.kind !== "user_input"
          ? new TextBlock(formatUserMessage(message), { color: tuiTheme.muted })
          : new UserMessageBlock(message),
      );
      break;

    case "assistant":
      addAssistantMessage(transcript, message, toolCalls, options);
      break;

    case "tool":
      addToolResult(transcript, message, toolCalls);
      break;
  }
}

function formatUserMessage(message: Extract<Message, { role: "user" }>): string {
  switch (message.provenance.kind) {
    case "scheduled_input":
      return `Scheduled wake: ${message.content.replace(/^\[Scheduled wake event\]\n?/, "")}`;
    case "recovery":
      return "Previous agent run was interrupted; recorded history was recovered safely.";
    case "user_input":
      return message.content;
    case "runtime_context":
      return "Runtime context updated.";
    case "tool_result_policy":
      return "Tool result policy context updated.";
    case "compaction_request":
    case "context_summary":
      return message.content;
  }
}

function addAssistantMessage(
  transcript: Transcript,
  message: AssistantMessage,
  toolCalls: Map<string, ToolCallContent>,
  options: { hyperlinks?: boolean; renderLatex?: boolean; renderMermaid?: boolean },
): void {
  const block = new AssistantMessageBlock(Date.now, options);
  block.update(message);
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

export function formatContextCompaction(beforeTokens: number, afterTokens: number): string {
  return `Context compacted · ${formatTokenCount(beforeTokens)} → ~${formatTokenCount(afterTokens)} tokens`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${formatTokenUnit(tokens / 1_000)}k`;
  }
  return `${formatTokenUnit(tokens / 1_000_000)}m`;
}

function formatTokenUnit(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
