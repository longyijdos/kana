import type { ModelUsage } from "./model";

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type AssistantStopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export type UserMessage = {
  role: "user";
  content: string;
  // The provider receives all prompts as user messages. This marker lets Kana
  // render internally scheduled prompts without presenting them as typed input.
  source?: "scheduled";
};

// Assistant content is ordered. Stream event contentIndex values refer to
// positions in this array.
export type AssistantMessage = {
  role: "assistant";
  stopReason?: AssistantStopReason;
  usage?: ModelUsage;
  content: AssistantContent[];
};

// content is the provider-facing text sent back to the model. result keeps the
// original structured value for the agent runtime.
export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  result?: unknown;
  isError: boolean;
};

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export type TextContent = {
  type: "text";
  text: string;
};

export type ThinkingContent = {
  type: "thinking";
  text: string;
};

export type ToolCallContent = {
  type: "tool_call";
  id: string;
  name: string;
  // Parsed arguments when possible. rawArgs keeps the original streamed JSON.
  args: unknown;
  rawArgs?: string;
};
