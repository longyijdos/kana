import { randomUUID } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import type { AgentEndReason, ContextCheckpoint } from "@/agent";
import {
  type Message,
  MODEL_USAGE_SCHEMA,
  type ModelUsage,
  TOOL_RESULT_ARTIFACT_SCHEMA,
  USER_IMAGE_SCHEMA,
  type UserMessage,
} from "@/core";
import { formatError, parseWithSchema } from "@/utils";
import type { KanaSubagentProfile } from "../subagents/profiles";
import { type KanaTodoItem, normalizeKanaTodoItems } from "../todo";

export const SESSION_VERSION = 6;
const CONTEXT_SUMMARY_FORMAT = "kana-context-summary-v1";
const DEFAULT_SESSION_TITLE = "Untitled session";
const MAX_SESSION_TITLE_LENGTH = 80;

export type KanaSessionMetadata = {
  readonly id: string;
  readonly createdAt: string;
  // Derived from the last persisted timeline entry on list/load and never
  // written back into the append-only header.
  readonly updatedAt: string;
  readonly title: string;
  readonly cwd: string;
  readonly path: string;
  readonly parentSessionPath?: string;
  readonly subagent?: KanaSubagentSessionIdentity;
};

type KanaSubagentSessionIdentity = {
  readonly parentSessionId: string;
  readonly spawnToolCallId: string;
  readonly profile: KanaSubagentProfile;
};

export type KanaSessionHeader = {
  readonly type: "session";
  readonly version: typeof SESSION_VERSION;
  readonly id: string;
  readonly createdAt: string;
  readonly title: string;
  readonly cwd: string;
  readonly parentSessionPath?: string;
  readonly subagent?: KanaSubagentSessionIdentity;
};

type KanaSessionTurnKind = "agent" | "snapshot";
export type KanaSessionTurnOutcome = AgentEndReason | "interrupted" | "snapshot";

export type KanaSessionTurnStartEntry = {
  readonly type: "turn_start";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly turnId: string;
  readonly kind: KanaSessionTurnKind;
};

export type KanaSessionTurnEndEntry = {
  readonly type: "turn_end";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly turnId: string;
  readonly outcome: KanaSessionTurnOutcome;
};

export type KanaSessionMessageEntry = {
  readonly type: "message";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly message: Message;
};

export type KanaSessionContextCompactionEntry = {
  readonly type: "context_compaction";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly reason: ContextCheckpoint["reason"];
  readonly baseCompactionId?: string;
  readonly coversThroughId: string;
  readonly compactedMessageCount: number;
  readonly beforeTokens: number;
  readonly estimatedAfterTokens: number;
  readonly summary: {
    readonly format: typeof CONTEXT_SUMMARY_FORMAT;
    readonly text: string;
  };
  readonly usage?: ModelUsage;
};

export type KanaSessionTodoStateEntry = {
  readonly type: "todo_state";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly toolCallId?: string;
  readonly parentToolCallId?: string;
  readonly items: readonly KanaTodoItem[];
};

export type KanaSessionTimelineEntry =
  | KanaSessionTurnStartEntry
  | KanaSessionMessageEntry
  | KanaSessionContextCompactionEntry
  | KanaSessionTodoStateEntry
  | KanaSessionTurnEndEntry;

export type CreateKanaSessionOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly id?: string;
  readonly title?: string;
  readonly parentSessionPath?: string;
  readonly subagent?: KanaSubagentSessionIdentity;
};

export type FindKanaSessionOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export type AppendKanaSessionMessagesOptions = {
  readonly timestamp?: string;
};

export type LoadKanaSessionResult = {
  readonly metadata: KanaSessionMetadata;
  readonly messages: readonly Message[];
  readonly timeline: readonly KanaSessionTimelineEntry[];
  readonly todoState: readonly KanaTodoItem[];
  readonly contextCheckpoint?: ContextCheckpoint;
  readonly recoveredInterruptedTurn?: {
    readonly turnId: string;
    readonly unknownToolCallCount: number;
  };
  readonly recoveredIncompleteTail?: boolean;
};

export type AppendCompactionOptions = {
  readonly turnId?: string;
};

export type AppendSnapshotOptions = AppendKanaSessionMessagesOptions & {
  readonly compactions?: readonly ContextCheckpoint[];
  readonly todoState?: readonly KanaTodoItem[];
};

export function createEntryId(): string {
  return randomUUID();
}

export function headerToMetadata(
  header: KanaSessionHeader,
  filePath: string,
  updatedAt: string,
): KanaSessionMetadata {
  return {
    id: header.id,
    createdAt: header.createdAt,
    updatedAt,
    title: header.title,
    cwd: header.cwd,
    path: filePath,
    parentSessionPath: header.parentSessionPath,
    subagent: header.subagent,
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
    parentSessionPath: metadata.parentSessionPath,
    subagent: metadata.subagent,
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
    message: message,
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

const nonEmptyString = Type.String({ minLength: 1 });
const nonNegativeInteger = Type.Integer({ minimum: 0 });
const positiveInteger = Type.Integer({ minimum: 1 });

const USER_PROVENANCE_SCHEMA = Type.Union([
  Type.Object({
    kind: Type.Enum(["user_input", "recovery", "context_summary", "compaction_request"]),
  }),
  Type.Object({ kind: Type.Literal("scheduled_input"), origin: Type.Enum(["user", "agent"]) }),
  Type.Object({
    kind: Type.Literal("goal_continuation"),
    goalId: nonEmptyString,
    round: positiveInteger,
  }),
  Type.Object({ kind: Type.Literal("job_completion"), jobId: nonEmptyString }),
  Type.Object({ kind: Type.Literal("subagent_completion"), agentId: nonEmptyString }),
  Type.Object({ kind: Type.Literal("user_task_completion"), taskId: nonEmptyString }),
  Type.Object({
    kind: Type.Enum(["runtime_context", "tool_result_policy"]),
    source: nonEmptyString,
  }),
]);

// Assistant content blocks carry provider-owned replay state, so only the
// envelope is validated here.
const MESSAGE_SCHEMA = Type.Union(
  [
    Type.Object({
      id: nonEmptyString,
      role: Type.Literal("user"),
      provenance: USER_PROVENANCE_SCHEMA,
      content: Type.String(),
      images: Type.Optional(Type.Array(USER_IMAGE_SCHEMA)),
    }),
    Type.Object({
      id: nonEmptyString,
      role: Type.Literal("assistant"),
      provenance: Type.Object({ kind: Type.Literal("model_output") }),
      content: Type.Array(Type.Unknown()),
    }),
    Type.Object({
      id: nonEmptyString,
      role: Type.Literal("tool"),
      provenance: Type.Object({ kind: Type.Literal("tool_result") }),
      toolCallId: Type.String(),
      toolName: Type.String(),
      content: Type.String(),
      durationMs: Type.Optional(Type.Number({ minimum: 0 })),
      images: Type.Optional(Type.Array(USER_IMAGE_SCHEMA)),
      artifact: Type.Optional(TOOL_RESULT_ARTIFACT_SCHEMA),
      isError: Type.Boolean(),
    }),
  ],
  { errorMessage: "must be a valid user, assistant, or tool message" },
);

const SUBAGENT_PROFILE_SCHEMA = Type.Object({
  name: Type.String(),
  description: Type.String(),
  instructions: Type.String(),
  tools: Type.Array(Type.String()),
  sourcePath: Type.Optional(Type.String()),
  digest: Type.String(),
  model: Type.Optional(
    Type.Object({
      provider: Type.String(),
      name: Type.String(),
      reasoningEffort: Type.Optional(Type.String()),
    }),
  ),
});

const HEADER_SCHEMA = Type.Object({
  type: Type.Literal("session"),
  version: Type.Literal(SESSION_VERSION),
  id: Type.String(),
  createdAt: Type.String(),
  title: Type.String(),
  cwd: Type.String(),
  parentSessionPath: Type.Optional(Type.String()),
  subagent: Type.Optional(
    Type.Object({
      parentSessionId: nonEmptyString,
      spawnToolCallId: nonEmptyString,
      profile: SUBAGENT_PROFILE_SCHEMA,
    }),
  ),
});

const ENTRY_IDENTITY = {
  id: Type.String(),
  parentId: Type.Union([Type.Null(), Type.String()]),
  timestamp: Type.String(),
};

const TIMELINE_ENTRY_SCHEMAS = {
  turn_start: Type.Object({
    type: Type.Literal("turn_start"),
    ...ENTRY_IDENTITY,
    turnId: Type.String(),
    kind: Type.Enum(["agent", "snapshot"]),
  }),
  message: Type.Object({
    type: Type.Literal("message"),
    ...ENTRY_IDENTITY,
    message: MESSAGE_SCHEMA,
  }),
  context_compaction: Type.Object({
    type: Type.Literal("context_compaction"),
    ...ENTRY_IDENTITY,
    reason: Type.Enum(["threshold", "provider_limit", "manual"]),
    baseCompactionId: Type.Optional(Type.String()),
    coversThroughId: Type.String(),
    compactedMessageCount: positiveInteger,
    beforeTokens: nonNegativeInteger,
    estimatedAfterTokens: nonNegativeInteger,
    summary: Type.Object({
      format: Type.Literal(CONTEXT_SUMMARY_FORMAT),
      text: Type.String({ pattern: "\\S" }),
    }),
    usage: Type.Optional(MODEL_USAGE_SCHEMA),
  }),
  todo_state: Type.Object({
    type: Type.Literal("todo_state"),
    ...ENTRY_IDENTITY,
    toolCallId: Type.Optional(nonEmptyString),
    parentToolCallId: Type.Optional(nonEmptyString),
    items: Type.Array(
      Type.Object(
        { content: Type.String(), status: Type.Enum(["pending", "in_progress", "completed"]) },
        { additionalProperties: false },
      ),
    ),
  }),
  turn_end: Type.Object({
    type: Type.Literal("turn_end"),
    ...ENTRY_IDENTITY,
    turnId: Type.String(),
    outcome: Type.Enum([
      "stop",
      "length",
      "aborted",
      "error",
      "turn_limit",
      "interrupted",
      "snapshot",
    ]),
  }),
};

const TIMELINE_ENTRY_LABELS: Record<keyof typeof TIMELINE_ENTRY_SCHEMAS, string> = {
  turn_start: "turn start",
  message: "message entry",
  context_compaction: "compaction entry",
  todo_state: "todo state",
  turn_end: "turn end",
};

export function parseHeader(line: string, filePath: string): KanaSessionHeader {
  const parsed = parseJsonRecord(line, filePath, 1);
  // Profile snapshots keep the provider name they were saved with.
  return parseRecord(
    HEADER_SCHEMA,
    parsed,
    `Invalid or unsupported Kana session header: ${filePath}`,
  ) as KanaSessionHeader;
}

export function parseTimelineEntry(
  line: string,
  filePath: string,
  lineNumber: number,
): KanaSessionTimelineEntry {
  const parsed = parseJsonRecord(line, filePath, lineNumber);
  const type = parsed.type as keyof typeof TIMELINE_ENTRY_SCHEMAS;
  if (!Object.hasOwn(TIMELINE_ENTRY_SCHEMAS, type)) {
    throw new Error(`Invalid Kana session timeline entry: ${filePath}:${lineNumber}`);
  }

  const failure = `Invalid Kana session ${TIMELINE_ENTRY_LABELS[type]}: ${filePath}:${lineNumber}`;
  const entry = parseRecord(TIMELINE_ENTRY_SCHEMAS[type], parsed, failure);
  if (entry.type === "todo_state" && !isPersistedTodoState(entry)) {
    throw new Error(failure);
  }
  return entry as KanaSessionTimelineEntry;
}

function parseRecord<T extends TSchema>(schema: T, value: unknown, failure: string): Static<T> {
  try {
    return parseWithSchema(schema, value, "record");
  } catch (error) {
    throw new Error(`${failure} (${formatError(error)})`, { cause: error });
  }
}

// Persisted todo lists are already normalized; a nested todo state must name
// the run_code call that owns it.
function isPersistedTodoState(entry: {
  readonly toolCallId?: string;
  readonly parentToolCallId?: string;
  readonly items: readonly KanaTodoItem[];
}): boolean {
  if (entry.parentToolCallId !== undefined && entry.toolCallId === undefined) {
    return false;
  }
  try {
    const normalized = normalizeKanaTodoItems(entry.items);
    return normalized.every((item, index) => item.content === entry.items[index]?.content);
  } catch {
    return false;
  }
}

function findFirstPrompt(messages: readonly Message[]): string | undefined {
  return messages.find(
    (message): message is UserMessage =>
      message.role === "user" &&
      message.provenance.kind !== "goal_continuation" &&
      message.provenance.kind !== "job_completion" &&
      message.provenance.kind !== "subagent_completion" &&
      message.provenance.kind !== "user_task_completion" &&
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
      `Invalid JSON in Kana session ${filePath}:${lineNumber}: ${formatError(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Kana session record: ${filePath}:${lineNumber}`);
  }

  return parsed as Record<string, unknown>;
}
