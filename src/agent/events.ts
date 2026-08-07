import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantStopReason,
  Message,
  ModelUsage,
  ToolResultMessage,
  UserMessage,
} from "@/core";
import type { ContextCompactionReason } from "./context-manager";

export type AgentEndReason = Exclude<AssistantStopReason, "toolUse"> | "turn_limit";

export type AgentEvent =
  | {
      type: "agent_start";
    }
  | {
      type: "agent_end";
      reason: AgentEndReason;
      messages: Message[];
    }
  | {
      type: "turn_start";
      turn: number;
    }
  | {
      type: "turn_end";
      turn: number;
      message: AssistantMessage;
      toolResults: ToolResultMessage[];
    }
  | {
      type: "turn_input";
      message: UserMessage;
    }
  | {
      type: "context_compaction_start";
      reason: ContextCompactionReason;
      estimatedTokens: number;
      contextLimit: number;
    }
  | {
      type: "context_compacted";
      reason: ContextCompactionReason;
      beforeTokens: number;
      estimatedAfterTokens: number;
      compactedMessageCount: number;
      contextLimit: number;
      usage?: ModelUsage;
    }
  | {
      type: "message_start";
      message: AssistantMessage;
    }
  | {
      type: "message_update";
      message: AssistantMessage;
      assistantMessageEvent: AssistantMessageEvent;
    }
  | {
      type: "message_end";
      message: AssistantMessage;
    }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
