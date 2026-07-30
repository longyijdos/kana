import type { ModelUsage } from "./model";

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type AssistantStopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export type UserMessage = {
  role: "user";
  content: string;
  // Providers receive internal wake and recovery records as user messages.
  // Keep their source so the TUI does not render them as user-authored input.
  source?: "scheduled" | "recovery";
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

export type ProviderState = {
  provider: string;
  // Provider adapters own replay semantics for this JSON-serializable value.
  // Kana persists opaque protocol state such as encrypted reasoning without
  // interpreting its contents.
  value: unknown;
};

export type TextContent = {
  type: "text";
  text: string;
  providerState?: ProviderState;
};

export type ThinkingContent = {
  type: "thinking";
  text: string;
  providerState?: ProviderState;
};

export type ToolCallContent = {
  type: "tool_call";
  id: string;
  name: string;
  // Parsed arguments when possible. rawArgs keeps the original streamed JSON.
  args: unknown;
  rawArgs?: string;
  providerState?: ProviderState;
};
