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
      readonly type: "agent_start";
    }
  | {
      readonly type: "agent_end";
      readonly reason: AgentEndReason;
      readonly messages: readonly Message[];
    }
  | {
      readonly type: "turn_start";
      readonly turn: number;
    }
  | {
      readonly type: "turn_end";
      readonly turn: number;
      readonly message: AssistantMessage;
      readonly toolResults: readonly ToolResultMessage[];
      readonly estimatedContextTokens?: number;
    }
  | {
      readonly type: "turn_input";
      readonly message: UserMessage;
    }
  | {
      readonly type: "context_compaction_start";
      readonly reason: ContextCompactionReason;
      readonly estimatedTokens: number;
      readonly contextLimit: number;
    }
  | {
      readonly type: "context_compacted";
      readonly reason: ContextCompactionReason;
      readonly beforeTokens: number;
      readonly estimatedAfterTokens: number;
      readonly compactedMessageCount: number;
      readonly contextLimit: number;
      readonly usage?: ModelUsage;
    }
  | {
      readonly type: "message_start";
      readonly message: AssistantMessage;
    }
  | {
      readonly type: "message_update";
      readonly message: AssistantMessage;
      readonly assistantMessageEvent: AssistantMessageEvent;
    }
  | {
      readonly type: "message_end";
      readonly message: AssistantMessage;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly parentToolCallId?: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly parentToolCallId?: string;
      readonly toolName: string;
      readonly args: unknown;
      readonly partialResult: unknown;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly parentToolCallId?: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError: boolean;
      readonly durationMs?: number;
    }
  | {
      readonly type: "tool_execution_pause" | "tool_execution_resume";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: "approval";
    };
