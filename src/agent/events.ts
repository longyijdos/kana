import type { AssistantMessageEvent } from "../core/events";
import type {
  AssistantMessage,
  AssistantStopReason,
  Message,
  ToolResultMessage,
} from "../core/messages";

export type AgentEndReason = Exclude<AssistantStopReason, "toolUse">;

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
