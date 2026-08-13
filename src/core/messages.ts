import type { ModelUsage } from "./model";

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type AssistantStopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export type UserMessage = {
  role: "user";
  content: string;
  // Images stay provider-neutral and JSON-serializable so sessions can replay
  // the same visual input through any adapter that supports it.
  images?: UserImage[];
  // Providers receive internal wake and recovery records as user messages.
  // Keep their source so the TUI does not render them as user-authored input.
  source?: "scheduled" | "recovery";
};

export type UserImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type UserImage = {
  mimeType: UserImageMimeType;
  // Raw base64 without a data-URL prefix. Provider adapters own their wire
  // representation, while Kana sessions keep the original bytes inline.
  data: string;
  width: number;
  height: number;
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

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent | HostedToolContent;

type ProviderState = {
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

export type HostedToolAction = {
  type: string;
  query?: string;
  queries?: string[];
  url?: string;
  pattern?: string;
};

// Hosted tools run inside a model provider. They remain ordered assistant
// content but never enter Kana's local tool runtime or approval flow.
export type HostedToolContent = {
  type: "hosted_tool";
  id: string;
  name: string;
  status: "in_progress" | "completed" | "canceled";
  action?: HostedToolAction;
  providerState?: ProviderState;
};
