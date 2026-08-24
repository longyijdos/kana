import { randomUUID } from "node:crypto";

import type { ModelUsage } from "./model";

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

declare const messageIdBrand: unique symbol;

export type MessageId = string & { readonly [messageIdBrand]: true };

export type MessageProvenance =
  | { kind: "user_input" }
  | { kind: "scheduled_input"; origin: "user" | "agent" }
  | { kind: "goal_continuation"; goalId: string; round: number }
  | { kind: "recovery" }
  | { kind: "model_output" }
  | { kind: "tool_result" }
  | { kind: "tool_result_policy"; source: string }
  | { kind: "runtime_context"; source: string }
  | { kind: "context_summary" }
  | { kind: "compaction_request" };

export type UserMessageProvenance = Extract<
  MessageProvenance,
  | { kind: "user_input" }
  | { kind: "scheduled_input" }
  | { kind: "goal_continuation" }
  | { kind: "recovery" }
  | { kind: "tool_result_policy" }
  | { kind: "runtime_context" }
  | { kind: "context_summary" }
  | { kind: "compaction_request" }
>;

type MessageIdentity<TProvenance extends MessageProvenance = MessageProvenance> = {
  // Message identity belongs to the logical content, not to a delivery lane,
  // runtime queue position, journal record, or provider protocol object.
  id: MessageId;
  provenance: TProvenance;
};

export function createMessageId(): MessageId {
  return randomUUID() as MessageId;
}

export function readMessageId(value: string): MessageId {
  if (value.length === 0) {
    throw new Error("Message id cannot be empty.");
  }
  return value as MessageId;
}

export function createMessageIdentity<TProvenance extends MessageProvenance>(
  provenance: TProvenance,
): MessageIdentity<TProvenance> {
  return {
    id: createMessageId(),
    provenance: structuredClone(provenance),
  };
}

export type AssistantStopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export type UserMessage = MessageIdentity<UserMessageProvenance> & {
  role: "user";
  content: string;
  // Images stay provider-neutral and JSON-serializable so sessions can replay
  // the same visual input through any adapter that supports it.
  images?: UserImage[];
};

export type CreateUserMessageOptions = Omit<UserMessage, "id" | "role"> & {
  id?: MessageId;
};

export function createUserMessage(options: CreateUserMessageOptions): UserMessage {
  return {
    id: options.id ?? createMessageId(),
    role: "user",
    content: options.content,
    provenance: structuredClone(options.provenance),
    ...(options.images === undefined ? {} : { images: structuredClone(options.images) }),
  };
}

export type UserImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type UserImage = {
  mimeType: UserImageMimeType;
  // Raw base64 without a data-URL prefix. Provider adapters own their wire
  // representation, while Kana sessions keep the original bytes inline.
  data: string;
  width: number;
  height: number;
};

export function isUserImage(value: unknown): value is UserImage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const image = value as Record<string, unknown>;
  return (
    isUserImageMimeType(image.mimeType) &&
    typeof image.data === "string" &&
    isPositiveInteger(image.width) &&
    isPositiveInteger(image.height)
  );
}

function isUserImageMimeType(value: unknown): value is UserImageMimeType {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// Assistant content is ordered. Stream event contentIndex values refer to
// positions in this array.
export type AssistantMessage = MessageIdentity<
  Extract<MessageProvenance, { kind: "model_output" }>
> & {
  role: "assistant";
  stopReason?: AssistantStopReason;
  usage?: ModelUsage;
  content: AssistantContent[];
};

// content is the provider-facing text sent back to the model. result keeps the
// original structured value for the agent runtime. Tool-produced images use
// the same provider-neutral, self-contained representation as user attachments.
export type ToolResultMessage = MessageIdentity<
  Extract<MessageProvenance, { kind: "tool_result" }>
> & {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  images?: UserImage[];
  // Artifact references are durable presentation metadata. The original host
  // result can remain execution-local while resume and session lifecycle code
  // still have a structured locator to follow.
  artifact?: ToolResultArtifact;
  result?: unknown;
  isError: boolean;
};

export type ToolResultArtifact = {
  kind: "text";
  locator: string;
  byteLength: number;
};

const MAX_TOOL_RESULT_ARTIFACT_LOCATOR_LENGTH = 4_096;

export function isToolResultArtifact(value: unknown): value is ToolResultArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const artifact = value as Record<string, unknown>;
  return (
    artifact.kind === "text" &&
    typeof artifact.locator === "string" &&
    artifact.locator.length > 0 &&
    artifact.locator.length <= MAX_TOOL_RESULT_ARTIFACT_LOCATOR_LENGTH &&
    !artifact.locator.includes("\0") &&
    typeof artifact.byteLength === "number" &&
    Number.isSafeInteger(artifact.byteLength) &&
    artifact.byteLength >= 0
  );
}

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
