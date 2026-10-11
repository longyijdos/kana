import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { ModelUsage } from "./usage";

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

declare const messageIdBrand: unique symbol;

export type MessageId = string & { readonly [messageIdBrand]: true };

export type MessageProvenance =
  | { kind: "user_input" }
  | { kind: "scheduled_input"; origin: "user" | "agent" }
  | { kind: "goal_continuation"; goalId: string; round: number }
  | { kind: "job_completion"; jobId: string }
  | { kind: "subagent_completion"; agentId: string }
  | { kind: "user_task_completion"; taskId: string }
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
  | { kind: "job_completion" }
  | { kind: "subagent_completion" }
  | { kind: "user_task_completion" }
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
    provenance: provenance,
  };
}

export type AssistantStopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export type UserMessage = MessageIdentity<UserMessageProvenance> & {
  readonly role: "user";
  readonly content: string;
  // Images stay provider-neutral and JSON-serializable so sessions can replay
  // the same visual input through any adapter that supports it.
  readonly images?: readonly UserImage[];
};

export type CreateUserMessageOptions = Omit<UserMessage, "id" | "role"> & {
  readonly id?: MessageId;
};

export function createUserMessage(options: CreateUserMessageOptions): UserMessage {
  return {
    id: options.id ?? createMessageId(),
    role: "user",
    content: options.content,
    provenance: options.provenance,
    ...(options.images === undefined ? {} : { images: options.images }),
  };
}

export type UserImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type UserImage = {
  readonly mimeType: UserImageMimeType;
  // Raw base64 without a data-URL prefix. Provider adapters own their wire
  // representation, while Kana sessions keep the original bytes inline.
  readonly data: string;
  readonly width: number;
  readonly height: number;
};

export const USER_IMAGE_SCHEMA = Type.Object({
  mimeType: Type.Enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: Type.String(),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
});

export function isUserImage(value: unknown): value is UserImage {
  return Value.Check(USER_IMAGE_SCHEMA, value);
}

// Assistant content is ordered. Stream event contentIndex values refer to
// positions in this array.
export type AssistantMessage = MessageIdentity<
  Extract<MessageProvenance, { kind: "model_output" }>
> & {
  readonly role: "assistant";
  readonly stopReason?: AssistantStopReason;
  readonly usage?: ModelUsage;
  readonly content: readonly AssistantContent[];
};

// content is the provider-facing text sent back to the model. result keeps the
// original structured value for the agent runtime. Tool-produced images use
// the same provider-neutral, self-contained representation as user attachments.
export type ToolResultMessage = MessageIdentity<
  Extract<MessageProvenance, { kind: "tool_result" }>
> & {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly durationMs?: number;
  readonly images?: readonly UserImage[];
  // Artifact references are durable presentation metadata. The original host
  // result can remain execution-local while resume and session lifecycle code
  // still have a structured locator to follow.
  readonly artifact?: ToolResultArtifact;
  readonly result?: unknown;
  readonly isError: boolean;
};

export type ToolResultArtifact = {
  readonly kind: "text";
  readonly locator: string;
  readonly byteLength: number;
};

export const TOOL_RESULT_ARTIFACT_SCHEMA = Type.Object({
  kind: Type.Literal("text"),
  locator: Type.String({ pattern: "^[^\\u0000]{1,4096}$" }),
  byteLength: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

export function isToolResultArtifact(value: unknown): value is ToolResultArtifact {
  return Value.Check(TOOL_RESULT_ARTIFACT_SCHEMA, value);
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent | HostedToolContent;

type ProviderState = {
  readonly provider: string;
  // Provider adapters own replay semantics for this JSON-serializable value.
  // Kana persists opaque protocol state such as encrypted reasoning without
  // interpreting its contents.
  readonly value: unknown;
};

export type TextContent = {
  readonly type: "text";
  readonly text: string;
  readonly providerState?: ProviderState;
};

export type ThinkingContent = {
  readonly type: "thinking";
  readonly text: string;
  readonly providerState?: ProviderState;
};

export type ToolCallContent = {
  readonly type: "tool_call";
  readonly id: string;
  readonly name: string;
  // Parsed arguments when possible. rawArgs keeps the original streamed JSON.
  readonly args: unknown;
  readonly rawArgs?: string;
  readonly providerState?: ProviderState;
};

export type HostedToolAction = {
  readonly type: string;
  readonly query?: string;
  readonly queries?: readonly string[];
  readonly url?: string;
  readonly pattern?: string;
};

// Hosted tools run inside a model provider. They remain ordered assistant
// content but never enter Kana's local tool runtime or approval flow.
export type HostedToolContent = {
  readonly type: "hosted_tool";
  readonly id: string;
  readonly name: string;
  readonly status: "in_progress" | "completed" | "canceled";
  readonly action?: HostedToolAction;
  readonly providerState?: ProviderState;
};
