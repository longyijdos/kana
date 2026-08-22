import { randomUUID } from "node:crypto";

import type { AgentEndReason, ContextCheckpoint } from "@/agent";
import {
  isUserImage,
  type Message,
  type MessageProvenance,
  type ModelMetadata,
  type ModelUsage,
  type UserMessage,
} from "@/core";

export const SESSION_VERSION = 4;
const CONTEXT_SUMMARY_FORMAT = "kana-context-summary-v1";
const DEFAULT_SESSION_TITLE = "Untitled session";
const MAX_SESSION_TITLE_LENGTH = 80;

type KanaSessionModelMetadata = Pick<ModelMetadata, "provider" | "model">;

export type KanaSessionMetadata = {
  id: string;
  createdAt: string;
  title: string;
  cwd: string;
  path: string;
  model?: KanaSessionModelMetadata;
  parentSessionPath?: string;
};

export type KanaSessionHeader = {
  type: "session";
  version: typeof SESSION_VERSION;
  id: string;
  createdAt: string;
  title: string;
  cwd: string;
  model?: KanaSessionModelMetadata;
  parentSessionPath?: string;
};

type KanaSessionTurnKind = "agent" | "snapshot";
export type KanaSessionTurnOutcome = AgentEndReason | "interrupted" | "snapshot";

export type KanaSessionTurnStartEntry = {
  type: "turn_start";
  id: string;
  parentId: string | null;
  timestamp: string;
  turnId: string;
  kind: KanaSessionTurnKind;
};

export type KanaSessionTurnEndEntry = {
  type: "turn_end";
  id: string;
  parentId: string | null;
  timestamp: string;
  turnId: string;
  outcome: KanaSessionTurnOutcome;
};

export type KanaSessionMessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: Message;
};

export type KanaSessionContextCompactionEntry = {
  type: "context_compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  reason: ContextCheckpoint["reason"];
  baseCompactionId?: string;
  coversThroughId: string;
  compactedMessageCount: number;
  beforeTokens: number;
  estimatedAfterTokens: number;
  summary: {
    format: typeof CONTEXT_SUMMARY_FORMAT;
    text: string;
  };
  usage?: ModelUsage;
};

export type KanaSessionTimelineEntry =
  | KanaSessionTurnStartEntry
  | KanaSessionMessageEntry
  | KanaSessionContextCompactionEntry
  | KanaSessionTurnEndEntry;

export type CreateKanaSessionOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  id?: string;
  title?: string;
  model?: KanaSessionModelMetadata;
  parentSessionPath?: string;
};

export type FindKanaSessionOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type AppendKanaSessionMessagesOptions = {
  timestamp?: string;
};

export type AppendKanaSessionRunOptions = AppendKanaSessionMessagesOptions & {
  compactions?: ContextCheckpoint[];
};

export type LoadKanaSessionResult = {
  metadata: KanaSessionMetadata;
  messages: Message[];
  timeline: KanaSessionTimelineEntry[];
  contextCheckpoint?: ContextCheckpoint;
  recoveredInterruptedTurn?: {
    turnId: string;
    unknownToolCallCount: number;
  };
  recoveredIncompleteTail?: boolean;
};

export type AppendCompactionOptions = {
  turnId?: string;
};

export type AppendSnapshotOptions = AppendKanaSessionRunOptions;

export function createEntryId(): string {
  return randomUUID();
}

export function headerToMetadata(header: KanaSessionHeader, filePath: string): KanaSessionMetadata {
  return {
    id: header.id,
    createdAt: header.createdAt,
    title: header.title,
    cwd: header.cwd,
    path: filePath,
    model: header.model,
    parentSessionPath: header.parentSessionPath,
  };
}

export function metadataToHeader(metadata: KanaSessionMetadata): KanaSessionHeader {
  return {
    type: "session",
    version: SESSION_VERSION,
    id: metadata.id,
    createdAt: metadata.createdAt,
    title: metadata.title,
    cwd: metadata.cwd,
    model: metadata.model,
    parentSessionPath: metadata.parentSessionPath,
  };
}

export function createMessageEntry(
  message: Message,
  parentId: string | null,
  timestamp: string,
): KanaSessionMessageEntry {
  return {
    type: "message",
    id: createEntryId(),
    parentId,
    timestamp,
    message: structuredClone(message),
  };
}

export function contextCheckpointToEntry(
  checkpoint: ContextCheckpoint,
  parentId: string | null,
  messageIds: string[],
  knownCompactionIds: ReadonlySet<string>,
): KanaSessionContextCompactionEntry {
  const coversThroughId = messageIds[checkpoint.coveredMessageCount - 1];
  if (!coversThroughId) {
    throw new Error("Context compaction does not reference a persisted message.");
  }
  if (knownCompactionIds.has(checkpoint.id)) {
    throw new Error("Context compaction checkpoint has already been persisted.");
  }
  if (checkpoint.baseCompactionId && !knownCompactionIds.has(checkpoint.baseCompactionId)) {
    throw new Error("Context compaction base checkpoint has not been persisted.");
  }

  return {
    type: "context_compaction",
    id: checkpoint.id,
    parentId,
    timestamp: checkpoint.createdAt,
    reason: checkpoint.reason,
    baseCompactionId: checkpoint.baseCompactionId,
    coversThroughId,
    compactedMessageCount: checkpoint.compactedMessageCount,
    beforeTokens: checkpoint.beforeTokens,
    estimatedAfterTokens: checkpoint.estimatedAfterTokens,
    summary: {
      format: CONTEXT_SUMMARY_FORMAT,
      text: checkpoint.summary,
    },
    usage: checkpoint.usage,
  };
}

export function assertContextCheckpointForAppend(checkpoint: ContextCheckpoint): void {
  if (
    typeof checkpoint.id !== "string" ||
    checkpoint.id.length === 0 ||
    typeof checkpoint.createdAt !== "string" ||
    checkpoint.createdAt.length === 0 ||
    (checkpoint.baseCompactionId !== undefined &&
      (typeof checkpoint.baseCompactionId !== "string" ||
        checkpoint.baseCompactionId.length === 0)) ||
    !isPositiveInteger(checkpoint.coveredMessageCount) ||
    !isPositiveInteger(checkpoint.createdAfterMessageCount) ||
    checkpoint.createdAfterMessageCount < checkpoint.coveredMessageCount ||
    !isPositiveInteger(checkpoint.compactedMessageCount) ||
    !isNonNegativeInteger(checkpoint.beforeTokens) ||
    !isNonNegativeInteger(checkpoint.estimatedAfterTokens) ||
    (checkpoint.reason !== "threshold" &&
      checkpoint.reason !== "provider_limit" &&
      checkpoint.reason !== "manual") ||
    typeof checkpoint.summary !== "string" ||
    checkpoint.summary.trim().length === 0 ||
    (checkpoint.usage !== undefined && !isModelUsage(checkpoint.usage))
  ) {
    throw new Error("Invalid context compaction checkpoint.");
  }
}

export function entryToContextCheckpoint(
  entry: KanaSessionContextCompactionEntry,
  coveredMessageCount: number,
  createdAfterMessageCount: number,
): ContextCheckpoint {
  return {
    id: entry.id,
    baseCompactionId: entry.baseCompactionId,
    summary: entry.summary.text,
    coveredMessageCount,
    createdAfterMessageCount,
    compactedMessageCount: entry.compactedMessageCount,
    reason: entry.reason,
    beforeTokens: entry.beforeTokens,
    estimatedAfterTokens: entry.estimatedAfterTokens,
    usage: entry.usage,
    createdAt: entry.timestamp,
  };
}

export function normalizeSessionTitle(title: string | undefined, messages: Message[] = []): string {
  const normalizedTitle = title?.replace(/\s+/g, " ").trim();
  const normalized = normalizedTitle || normalizePromptTitle(findFirstPrompt(messages));

  if (!normalized) {
    return DEFAULT_SESSION_TITLE;
  }

  return normalized.length > MAX_SESSION_TITLE_LENGTH
    ? normalized.slice(0, MAX_SESSION_TITLE_LENGTH)
    : normalized;
}

export function parseHeader(line: string, filePath: string): KanaSessionHeader {
  const parsed = parseJsonRecord(line, filePath, 1);

  if (
    parsed.type !== "session" ||
    parsed.version !== SESSION_VERSION ||
    typeof parsed.id !== "string" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.title !== "string" ||
    typeof parsed.cwd !== "string"
  ) {
    throw new Error(`Invalid or unsupported Kana session header: ${filePath}`);
  }

  if (parsed.model !== undefined && !isSessionModelMetadata(parsed.model)) {
    throw new Error(`Invalid Kana session model metadata: ${filePath}`);
  }
  if (parsed.parentSessionPath !== undefined && typeof parsed.parentSessionPath !== "string") {
    throw new Error(`Invalid Kana session parent path: ${filePath}`);
  }

  return parsed as KanaSessionHeader;
}

export function parseTimelineEntry(
  line: string,
  filePath: string,
  lineNumber: number,
): KanaSessionTimelineEntry {
  const parsed = parseJsonRecord(line, filePath, lineNumber);

  if (parsed.type === "turn_start") {
    if (
      !hasTimelineIdentity(parsed) ||
      typeof parsed.turnId !== "string" ||
      (parsed.kind !== "agent" && parsed.kind !== "snapshot")
    ) {
      throw new Error(`Invalid Kana session turn start: ${filePath}:${lineNumber}`);
    }
    return parsed as KanaSessionTurnStartEntry;
  }

  if (parsed.type === "message") {
    if (!hasTimelineIdentity(parsed) || !isMessage(parsed.message)) {
      throw new Error(`Invalid Kana session message entry: ${filePath}:${lineNumber}`);
    }
    return parsed as KanaSessionMessageEntry;
  }

  if (parsed.type === "context_compaction") {
    if (!isContextCompactionEntry(parsed)) {
      throw new Error(`Invalid Kana session compaction entry: ${filePath}:${lineNumber}`);
    }
    return parsed;
  }

  if (parsed.type === "turn_end") {
    if (
      !hasTimelineIdentity(parsed) ||
      typeof parsed.turnId !== "string" ||
      !isTurnOutcome(parsed.outcome)
    ) {
      throw new Error(`Invalid Kana session turn end: ${filePath}:${lineNumber}`);
    }
    return parsed as KanaSessionTurnEndEntry;
  }

  throw new Error(`Invalid Kana session timeline entry: ${filePath}:${lineNumber}`);
}

function findFirstPrompt(messages: Message[]): string | undefined {
  return messages.find(
    (message): message is UserMessage =>
      message.role === "user" &&
      message.provenance.kind !== "recovery" &&
      message.provenance.kind !== "tool_result_policy" &&
      message.provenance.kind !== "runtime_context",
  )?.content;
}

function normalizePromptTitle(prompt: string | undefined): string {
  return (prompt ?? "").replace(/\s+/g, " ").trim();
}

function parseJsonRecord(
  line: string,
  filePath: string,
  lineNumber: number,
): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in Kana session ${filePath}:${lineNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Kana session record: ${filePath}:${lineNumber}`);
  }

  return parsed as Record<string, unknown>;
}

function hasTimelineIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string"
  );
}

function isContextCompactionEntry(
  value: Record<string, unknown>,
): value is KanaSessionContextCompactionEntry {
  const summary = value.summary;

  return (
    hasTimelineIdentity(value) &&
    (value.reason === "threshold" ||
      value.reason === "provider_limit" ||
      value.reason === "manual") &&
    (value.baseCompactionId === undefined || typeof value.baseCompactionId === "string") &&
    typeof value.coversThroughId === "string" &&
    isPositiveInteger(value.compactedMessageCount) &&
    isNonNegativeInteger(value.beforeTokens) &&
    isNonNegativeInteger(value.estimatedAfterTokens) &&
    typeof summary === "object" &&
    summary !== null &&
    !Array.isArray(summary) &&
    (summary as Record<string, unknown>).format === CONTEXT_SUMMARY_FORMAT &&
    typeof (summary as Record<string, unknown>).text === "string" &&
    ((summary as Record<string, unknown>).text as string).trim().length > 0 &&
    (value.usage === undefined || isModelUsage(value.usage))
  );
}

function isTurnOutcome(value: unknown): value is KanaSessionTurnOutcome {
  return (
    value === "stop" ||
    value === "length" ||
    value === "aborted" ||
    value === "error" ||
    value === "turn_limit" ||
    value === "interrupted" ||
    value === "snapshot"
  );
}

function isSessionModelMetadata(value: unknown): value is KanaSessionModelMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).provider === "string" &&
    typeof (value as Record<string, unknown>).model === "string"
  );
}

function isModelUsage(value: unknown): value is ModelUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const usage = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(usage.promptTokens) &&
    isNonNegativeInteger(usage.completionTokens) &&
    isNonNegativeInteger(usage.totalTokens) &&
    isOptionalNonNegativeInteger(usage.promptCacheHitTokens) &&
    isOptionalNonNegativeInteger(usage.promptCacheMissTokens) &&
    isOptionalNonNegativeInteger(usage.reasoningTokens)
  );
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;
  if (!hasMessageIdentity(message)) {
    return false;
  }

  if (message.role === "user") {
    return isUserMessage(value);
  }
  if (message.role === "assistant") {
    return message.provenance.kind === "model_output" && Array.isArray(message.content);
  }
  return (
    message.role === "tool" &&
    message.provenance.kind === "tool_result" &&
    typeof message.toolCallId === "string" &&
    typeof message.toolName === "string" &&
    typeof message.content === "string" &&
    (message.images === undefined ||
      (Array.isArray(message.images) && message.images.every(isUserImage))) &&
    typeof message.isError === "boolean"
  );
}

function isUserMessage(value: unknown): value is UserMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;
  return (
    hasMessageIdentity(message) &&
    message.role === "user" &&
    isUserMessageProvenance(message.provenance) &&
    typeof message.content === "string" &&
    (message.images === undefined ||
      (Array.isArray(message.images) && message.images.every(isUserImage)))
  );
}

function isUserMessageProvenance(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const kind = (value as Record<string, unknown>).kind;
  return (
    kind === "user_input" ||
    kind === "scheduled_input" ||
    kind === "recovery" ||
    kind === "tool_result_policy" ||
    kind === "runtime_context" ||
    kind === "context_summary" ||
    kind === "compaction_request"
  );
}

function hasMessageIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { id: string; provenance: MessageProvenance } {
  return (
    typeof value.id === "string" && value.id.length > 0 && isMessageProvenance(value.provenance)
  );
}

function isMessageProvenance(value: unknown): value is MessageProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const provenance = value as Record<string, unknown>;
  if (provenance.kind === "scheduled_input") {
    return provenance.origin === "user" || provenance.origin === "agent";
  }
  if (provenance.kind === "runtime_context" || provenance.kind === "tool_result_policy") {
    return typeof provenance.source === "string" && provenance.source.length > 0;
  }
  return (
    provenance.kind === "user_input" ||
    provenance.kind === "recovery" ||
    provenance.kind === "model_output" ||
    provenance.kind === "tool_result" ||
    provenance.kind === "context_summary" ||
    provenance.kind === "compaction_request"
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}
