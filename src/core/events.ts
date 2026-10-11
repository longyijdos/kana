import type {
  AssistantMessage,
  AssistantStopReason,
  HostedToolContent,
  ToolCallContent,
} from "./messages";
import type { ModelUsage } from "./usage";

type StopReason = AssistantStopReason;

// delta is the increment parsed from the current provider stream chunk.
// snapshot is the assistant message after applying that increment.
export type AssistantMessageEvent =
  | {
      readonly type: "start";
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "text_start";
      readonly contentIndex: number;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "text_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "text_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "thinking_start";
      readonly contentIndex: number;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "thinking_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "thinking_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "toolcall_start";
      readonly contentIndex: number;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "toolcall_delta";
      readonly contentIndex: number;
      // For tool calls this is the raw function arguments delta.
      readonly delta: string;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "toolcall_end";
      readonly contentIndex: number;
      readonly toolCall: ToolCallContent;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "hosted_tool_start";
      readonly contentIndex: number;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "hosted_tool_end";
      readonly contentIndex: number;
      readonly hostedTool: HostedToolContent;
      readonly snapshot: AssistantMessage;
    }
  | {
      readonly type: "done";
      readonly reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      readonly message: AssistantMessage;
      readonly usage?: ModelUsage;
    }
  | {
      readonly type: "error";
      readonly reason: Extract<StopReason, "aborted" | "error">;
      readonly error: unknown;
      readonly snapshot?: AssistantMessage;
    };
