import type { AssistantMessage, ToolCallContent } from "./messages";

export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

// delta is the increment parsed from the current provider stream chunk.
// snapshot is the assistant message after applying that increment.
export type AssistantMessageEvent =
  | {
      type: "start";
      snapshot: AssistantMessage;
    }
  | {
      type: "text_start";
      contentIndex: number;
      snapshot: AssistantMessage;
    }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      snapshot: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      snapshot: AssistantMessage;
    }
  | {
      type: "thinking_start";
      contentIndex: number;
      snapshot: AssistantMessage;
    }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      snapshot: AssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      snapshot: AssistantMessage;
    }
  | {
      type: "toolcall_start";
      contentIndex: number;
      snapshot: AssistantMessage;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      // For tool calls this is the raw function arguments delta.
      delta: string;
      snapshot: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCallContent;
      snapshot: AssistantMessage;
    }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      error: unknown;
      snapshot?: AssistantMessage;
    };
