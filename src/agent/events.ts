import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantStopReason,
  Message,
  ModelUsage,
  ToolResultMessage,
  UserMessage,
} from "@/core";
import type { Logger } from "@/logging";
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

export function logAgentEvent(logger: Logger, event: AgentEvent): void {
  switch (event.type) {
    case "agent_start":
      logger.debug("agent.started");
      break;
    case "turn_start":
      logger.debug("agent.turn_started", { turn: event.turn });
      break;
    case "turn_end":
      logger.debug("agent.turn_ended", {
        turn: event.turn,
        stopReason: event.message.stopReason,
        toolResultCount: event.toolResults.length,
      });
      break;
    case "turn_input":
      break;
    case "tool_execution_start":
      logger.debug("tool.execution_started", { toolName: event.toolName });
      break;
    case "tool_execution_pause":
    case "tool_execution_resume":
      logger.debug(
        event.type === "tool_execution_pause" ? "tool.execution_paused" : "tool.execution_resumed",
        { toolName: event.toolName, reason: event.reason },
      );
      break;
    case "tool_execution_end":
      if (event.isError) {
        logger.warn("tool.execution_failed", { toolName: event.toolName });
        break;
      }
      logger.debug("tool.execution_ended", {
        toolName: event.toolName,
      });
      break;
    case "agent_end":
      logger.info("agent.ended", {
        reason: event.reason,
        committedMessageCount: event.messages.length,
      });
      break;

    case "message_start":
    case "message_update":
    case "message_end":
    case "tool_execution_update":
    case "context_compaction_start":
    case "context_compacted":
      break;
  }
}
