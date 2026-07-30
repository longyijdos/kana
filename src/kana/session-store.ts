import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
} from "node:fs";
import path from "node:path";

import type { AgentEndReason, ContextCheckpoint } from "@/agent";
import type {
  Message,
  ModelMetadata,
  ModelUsage,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "@/core";
import { getKanaConfigPaths } from "./config";
import { encodeKanaWorkspacePath } from "./path";

const SESSION_VERSION = 3;
const CONTEXT_SUMMARY_FORMAT = "kana-context-summary-v1";
const DEFAULT_SESSION_TITLE = "Untitled session";
const MAX_SESSION_TITLE_LENGTH = 80;
const INTERRUPTED_TOOL_RESULT =
  "Kana was interrupted before this tool result was recorded. The tool may have completed; do not retry it automatically.";

export type KanaSessionModelMetadata = Pick<ModelMetadata, "provider" | "model">;

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

export type KanaSessionTurnKind = "agent" | "snapshot";
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

export type KanaSessionEntry = KanaSessionHeader | KanaSessionTimelineEntry;

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

type AppendCompactionOptions = {
  turnId?: string;
};

type AppendSnapshotOptions = AppendKanaSessionRunOptions;

type JournalState = {
  tailId: string | null;
  entryIds: Set<string>;
  turnIds: Set<string>;
  activeTurn?: KanaSessionTurnStartEntry;
  activeTurnMessages: Message[];
  messageIds: string[];
  compactionIds: Set<string>;
};

export class KanaSessionJournal {
  // One journal instance owns the append position for an active session.
  // Cached ids avoid reparsing an increasingly large JSONL file per message.
  private readonly state: JournalState = {
    tailId: null,
    entryIds: new Set<string>(),
    turnIds: new Set<string>(),
    activeTurnMessages: [],
    messageIds: [],
    compactionIds: new Set<string>(),
  };
  private fileCreated: boolean;
  private writeFailed = false;

  constructor(
    private readonly session: KanaSessionMetadata,
    timeline: readonly KanaSessionTimelineEntry[] = [],
  ) {
    this.fileCreated = existsSync(session.path);
    for (const entry of timeline) {
      this.applyEntry(entry);
    }
  }

  get activeTurnId(): string | undefined {
    return this.state.activeTurn?.turnId;
  }

  startTurn(
    turnId: string,
    messages: Extract<Message, { role: "user" }>[],
    options: AppendKanaSessionMessagesOptions = {},
  ): KanaSessionTimelineEntry[] {
    if (this.state.activeTurn) {
      throw new Error(
        `Cannot start session turn ${turnId}; turn ${this.state.activeTurn.turnId} is still open.`,
      );
    }
    if (!turnId) {
      throw new Error("Session turn id cannot be empty.");
    }

    const timestamp = options.timestamp ?? new Date().toISOString();
    const entries: KanaSessionTimelineEntry[] = [];
    let parentId = this.state.tailId;
    const startEntry: KanaSessionTurnStartEntry = {
      type: "turn_start",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId,
      kind: "agent",
    };
    entries.push(startEntry);
    parentId = startEntry.id;

    for (const message of messages) {
      const entry = createMessageEntry(message, parentId, timestamp);
      entries.push(entry);
      parentId = entry.id;
    }

    this.appendEntries(entries, messages);
    return structuredClone(entries);
  }

  appendMessage(
    turnId: string,
    message: Message,
    options: AppendKanaSessionMessagesOptions = {},
  ): KanaSessionMessageEntry {
    this.assertActiveTurn(turnId);
    const entry = createMessageEntry(
      message,
      this.state.tailId,
      options.timestamp ?? new Date().toISOString(),
    );

    this.appendEntries([entry]);
    return structuredClone(entry);
  }

  appendCompaction(
    checkpoint: ContextCheckpoint,
    options: AppendCompactionOptions = {},
  ): KanaSessionContextCompactionEntry {
    assertContextCheckpointForAppend(checkpoint);
    if (options.turnId !== undefined) {
      this.assertActiveTurn(options.turnId);
    } else if (this.state.activeTurn) {
      throw new Error(
        `Session turn ${this.state.activeTurn.turnId} must own compactions written while it is open.`,
      );
    }
    if (checkpoint.createdAfterMessageCount !== this.state.messageIds.length) {
      throw new Error(
        "Context compaction must be journaled immediately after the messages it was created from.",
      );
    }

    const entry = contextCheckpointToEntry(
      checkpoint,
      this.state.tailId,
      this.state.messageIds,
      this.state.compactionIds,
    );
    this.appendEntries([entry]);
    return structuredClone(entry);
  }

  endTurn(
    turnId: string,
    outcome: KanaSessionTurnOutcome,
    options: AppendKanaSessionMessagesOptions = {},
  ): KanaSessionTurnEndEntry {
    this.assertActiveTurn(turnId);
    const entry: KanaSessionTurnEndEntry = {
      type: "turn_end",
      id: createEntryId(),
      parentId: this.state.tailId,
      timestamp: options.timestamp ?? new Date().toISOString(),
      turnId,
      outcome,
    };

    this.appendEntries([entry]);
    return structuredClone(entry);
  }

  appendSnapshot(
    messages: Message[],
    options: AppendSnapshotOptions = {},
  ): KanaSessionTimelineEntry[] {
    if (this.state.activeTurn) {
      throw new Error(
        `Cannot append a session snapshot while turn ${this.state.activeTurn.turnId} is open.`,
      );
    }

    const compactions = structuredClone(options.compactions ?? []);
    for (const checkpoint of compactions) {
      assertContextCheckpointForAppend(checkpoint);
    }
    compactions.sort(
      (left, right) => left.createdAfterMessageCount - right.createdAfterMessageCount,
    );

    if (messages.length === 0) {
      const entries: KanaSessionContextCompactionEntry[] = [];
      let parentId = this.state.tailId;
      const knownCompactionIds = new Set(this.state.compactionIds);

      for (const checkpoint of compactions) {
        if (checkpoint.createdAfterMessageCount !== this.state.messageIds.length) {
          throw new Error(
            "Context compaction references messages that have not been persisted at this timeline position.",
          );
        }
        const entry = contextCheckpointToEntry(
          checkpoint,
          parentId,
          this.state.messageIds,
          knownCompactionIds,
        );
        entries.push(entry);
        parentId = entry.id;
        knownCompactionIds.add(entry.id);
      }

      this.appendEntries(entries);
      return structuredClone(entries);
    }

    const timestamp = options.timestamp ?? new Date().toISOString();
    const turnId = randomUUID();
    const entries: KanaSessionTimelineEntry[] = [];
    const messageIds = [...this.state.messageIds];
    const knownCompactionIds = new Set(this.state.compactionIds);
    let messageCount = messageIds.length;
    let parentId = this.state.tailId;
    let compactionIndex = 0;

    const startEntry: KanaSessionTurnStartEntry = {
      type: "turn_start",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId,
      kind: "snapshot",
    };
    entries.push(startEntry);
    parentId = startEntry.id;

    const appendEligibleCompactions = (): void => {
      while (
        compactionIndex < compactions.length &&
        (compactions[compactionIndex]?.createdAfterMessageCount ?? Number.POSITIVE_INFINITY) <=
          messageCount
      ) {
        const checkpoint = compactions[compactionIndex];
        if (!checkpoint) {
          break;
        }
        if (checkpoint.createdAfterMessageCount < this.state.messageIds.length) {
          throw new Error("Context compaction predates the snapshot being appended.");
        }
        const entry = contextCheckpointToEntry(
          checkpoint,
          parentId,
          messageIds,
          knownCompactionIds,
        );
        entries.push(entry);
        parentId = entry.id;
        knownCompactionIds.add(entry.id);
        compactionIndex += 1;
      }
    };

    appendEligibleCompactions();
    for (const message of messages) {
      const entry = createMessageEntry(message, parentId, timestamp);
      entries.push(entry);
      parentId = entry.id;
      messageIds.push(entry.id);
      messageCount += 1;
      appendEligibleCompactions();
    }

    if (compactionIndex !== compactions.length) {
      throw new Error("Context compaction references messages that have not been persisted.");
    }

    const endEntry: KanaSessionTurnEndEntry = {
      type: "turn_end",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId,
      outcome: "snapshot",
    };
    entries.push(endEntry);

    this.appendEntries(entries, messages);
    return structuredClone(entries);
  }

  recoverInterruptedTurn(): {
    entries: KanaSessionTimelineEntry[];
    turnId: string;
    unknownToolCallCount: number;
  } {
    const activeTurn = this.state.activeTurn;
    if (!activeTurn) {
      throw new Error("Cannot recover a session without an interrupted turn.");
    }

    const unresolvedToolCalls = findUnresolvedToolCalls(this.state.activeTurnMessages);
    const timestamp = new Date().toISOString();
    const entries: KanaSessionTimelineEntry[] = [];
    let parentId = this.state.tailId;

    for (const toolCall of unresolvedToolCalls) {
      // A missing result cannot distinguish "never started" from "completed
      // before the process exited". Record an unknown outcome, never a retry.
      const message: ToolResultMessage = {
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: INTERRUPTED_TOOL_RESULT,
        result: {
          status: "unknown",
          message: INTERRUPTED_TOOL_RESULT,
        },
        isError: true,
      };
      const entry = createMessageEntry(message, parentId, timestamp);
      entries.push(entry);
      parentId = entry.id;
    }

    const recoveryMessage = createMessageEntry(
      {
        role: "user",
        source: "recovery",
        content:
          unresolvedToolCalls.length > 0
            ? `[Session recovery]\nThe previous agent run was interrupted. ${unresolvedToolCalls.length} tool call outcome(s) are unknown and must not be retried automatically.`
            : "[Session recovery]\nThe previous agent run was interrupted. Continue only from messages that were fully recorded.",
      },
      parentId,
      timestamp,
    );
    entries.push(recoveryMessage);
    parentId = recoveryMessage.id;

    const endEntry: KanaSessionTurnEndEntry = {
      type: "turn_end",
      id: createEntryId(),
      parentId,
      timestamp,
      turnId: activeTurn.turnId,
      outcome: "interrupted",
    };
    entries.push(endEntry);

    this.appendEntries(entries);
    return {
      entries: structuredClone(entries),
      turnId: activeTurn.turnId,
      unknownToolCallCount: unresolvedToolCalls.length,
    };
  }

  private appendEntries(
    entries: readonly KanaSessionTimelineEntry[],
    titleMessages: readonly Message[] = [],
  ): void {
    if (entries.length === 0) {
      return;
    }
    if (this.writeFailed) {
      throw new Error("Kana session journal requires a reload after its previous write failed.");
    }
    if (this.fileCreated && !existsSync(this.session.path)) {
      throw new Error(`Kana session file disappeared while it was open: ${this.session.path}`);
    }
    if (!this.fileCreated && existsSync(this.session.path)) {
      throw new Error(`Kana session file was created by another writer: ${this.session.path}`);
    }

    const title = this.fileCreated
      ? this.session.title
      : normalizeSessionTitle(this.session.title, [...titleMessages]);
    const content = [
      ...(!this.fileCreated
        ? [
            JSON.stringify(
              metadataToHeader({
                ...this.session,
                title,
              }),
            ),
          ]
        : []),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n");

    mkdirSync(path.dirname(this.session.path), { recursive: true });
    try {
      appendFileSync(this.session.path, `${content}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      this.session.title = title;
      this.fileCreated = true;
      for (const entry of entries) {
        this.applyEntry(entry);
      }
    } catch (error) {
      // appendFileSync can fail after a partial write. Poison this cached
      // writer so only a reload with tail recovery can resume the session.
      this.writeFailed = true;
      throw error;
    }
  }

  private applyEntry(entry: KanaSessionTimelineEntry): void {
    if (entry.parentId !== this.state.tailId) {
      throw new Error(
        `Kana session entry ${entry.id} does not follow parent ${this.state.tailId ?? "null"}.`,
      );
    }
    if (this.state.entryIds.has(entry.id)) {
      throw new Error(`Duplicate Kana session entry id: ${entry.id}`);
    }

    switch (entry.type) {
      case "turn_start":
        if (this.state.activeTurn) {
          throw new Error(
            `Kana session turn ${entry.turnId} started before turn ${this.state.activeTurn.turnId} ended.`,
          );
        }
        if (this.state.turnIds.has(entry.turnId)) {
          throw new Error(`Duplicate Kana session turn id: ${entry.turnId}`);
        }
        this.state.activeTurn = structuredClone(entry);
        this.state.activeTurnMessages = [];
        this.state.turnIds.add(entry.turnId);
        break;

      case "message":
        if (!this.state.activeTurn) {
          throw new Error(`Kana session message ${entry.id} is outside a turn.`);
        }
        this.state.messageIds.push(entry.id);
        this.state.activeTurnMessages.push(structuredClone(entry.message));
        break;

      case "context_compaction":
        if (!this.state.messageIds.includes(entry.coversThroughId)) {
          throw new Error(
            `Kana session compaction ${entry.id} references unknown message ${entry.coversThroughId}.`,
          );
        }
        if (
          entry.baseCompactionId !== undefined &&
          !this.state.compactionIds.has(entry.baseCompactionId)
        ) {
          throw new Error(
            `Kana session compaction ${entry.id} references unknown checkpoint ${entry.baseCompactionId}.`,
          );
        }
        this.state.compactionIds.add(entry.id);
        break;

      case "turn_end":
        this.assertActiveTurn(entry.turnId);
        this.state.activeTurn = undefined;
        this.state.activeTurnMessages = [];
        break;
    }

    this.state.entryIds.add(entry.id);
    this.state.tailId = entry.id;
  }

  private assertActiveTurn(turnId: string): void {
    if (this.state.activeTurn?.turnId !== turnId) {
      throw new Error(
        this.state.activeTurn
          ? `Session turn ${this.state.activeTurn.turnId} is active, not ${turnId}.`
          : `Session turn ${turnId} is not active.`,
      );
    }
  }
}

export function createKanaSession(options: CreateKanaSessionOptions = {}): KanaSessionMetadata {
  const id = options.id ?? createSessionId();
  const createdAt = new Date().toISOString();
  const cwd = options.cwd ?? process.cwd();
  const sessionDir = getKanaSessionDir(cwd, options.env);
  const filePath = path.join(sessionDir, `${safeTimestamp(createdAt)}_${id}.jsonl`);
  const header: KanaSessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    createdAt,
    title: options.title === undefined ? "" : normalizeSessionTitle(options.title),
    cwd,
    model: options.model,
    parentSessionPath: options.parentSessionPath,
  };

  return headerToMetadata(header, filePath);
}

export function createKanaSessionJournal(
  session: KanaSessionMetadata,
  timeline: readonly KanaSessionTimelineEntry[] = [],
): KanaSessionJournal {
  return new KanaSessionJournal(session, timeline);
}

export function loadKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions = {},
): LoadKanaSessionResult {
  const metadata = findKanaSession(sessionId, options);

  if (!metadata) {
    throw new Error(`Kana session not found: ${sessionId}`);
  }

  return loadKanaSessionFile(metadata.path);
}

export function listKanaSessions(options: FindKanaSessionOptions = {}): KanaSessionMetadata[] {
  const sessionsPath = getKanaConfigPaths(options.env).sessionsPath;
  const sessionDirs = options.cwd
    ? [getKanaSessionDir(options.cwd, options.env)]
    : listDirectories(sessionsPath);
  const sessions: KanaSessionMetadata[] = [];

  for (const sessionDir of sessionDirs) {
    if (!existsSync(sessionDir)) {
      continue;
    }

    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      try {
        sessions.push(loadKanaSessionMetadata(path.join(sessionDir, entry.name)));
      } catch {
        // Ignore malformed or obsolete sessions when listing so one bad file
        // does not hide the current-format sessions.
      }
    }
  }

  return sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function deleteKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions = {},
): boolean {
  const metadata = findKanaSession(sessionId, options);

  if (!metadata) {
    return false;
  }

  rmSync(metadata.path, { force: true });
  return true;
}

export function appendKanaSessionMessages(
  session: KanaSessionMetadata,
  messages: Message[],
  options: AppendKanaSessionMessagesOptions = {},
): void {
  appendKanaSessionRun(session, messages, options);
}

export function appendKanaSessionRun(
  session: KanaSessionMetadata,
  messages: Message[],
  options: AppendKanaSessionRunOptions = {},
): KanaSessionTimelineEntry[] {
  if (messages.length === 0 && (options.compactions?.length ?? 0) === 0) {
    return [];
  }

  const timeline = existsSync(session.path) ? readKanaSessionFile(session.path).timeline : [];
  const journal = createKanaSessionJournal(session, timeline);
  return journal.appendSnapshot(messages, options);
}

function findKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions,
): KanaSessionMetadata | undefined {
  return listKanaSessions(options).find((session) => session.id === sessionId);
}

function loadKanaSessionFile(filePath: string): LoadKanaSessionResult {
  let parsed = readKanaSessionFile(filePath);
  const recoveredIncompleteTail = parsed.recoveredIncompleteTail;
  let recoveredInterruptedTurn: LoadKanaSessionResult["recoveredInterruptedTurn"];

  const initialMetadata = headerToMetadata(parsed.header, filePath);
  const initialJournal = createKanaSessionJournal(initialMetadata, parsed.timeline);
  if (initialJournal.activeTurnId) {
    const recovered = initialJournal.recoverInterruptedTurn();
    recoveredInterruptedTurn = {
      turnId: recovered.turnId,
      unknownToolCallCount: recovered.unknownToolCallCount,
    };
    parsed = readKanaSessionFile(filePath);
  }

  const metadata = headerToMetadata(parsed.header, filePath);
  // Validate ordering and references before exposing any recovered state.
  createKanaSessionJournal(metadata, parsed.timeline);
  const messages: Message[] = [];
  const messageIds = new Map<string, number>();
  const compactionIds = new Set<string>();
  let contextCheckpoint: ContextCheckpoint | undefined;

  for (const entry of parsed.timeline) {
    if (entry.type === "message") {
      messages.push(structuredClone(entry.message));
      messageIds.set(entry.id, messages.length);
      continue;
    }
    if (entry.type !== "context_compaction") {
      continue;
    }

    const coveredMessageCount = messageIds.get(entry.coversThroughId);
    if (coveredMessageCount === undefined) {
      throw new Error(
        `Kana session compaction ${entry.id} references unknown message ${entry.coversThroughId}: ${filePath}`,
      );
    }
    if (entry.baseCompactionId && !compactionIds.has(entry.baseCompactionId)) {
      throw new Error(
        `Kana session compaction ${entry.id} references unknown checkpoint ${entry.baseCompactionId}: ${filePath}`,
      );
    }

    contextCheckpoint = entryToContextCheckpoint(entry, coveredMessageCount, messages.length);
    compactionIds.add(entry.id);
  }

  return {
    metadata,
    messages,
    timeline: structuredClone(parsed.timeline),
    contextCheckpoint,
    recoveredInterruptedTurn,
    recoveredIncompleteTail: recoveredIncompleteTail || undefined,
  };
}

function loadKanaSessionMetadata(filePath: string): KanaSessionMetadata {
  const [line] = readSessionLines(filePath).lines;
  return headerToMetadata(parseHeader(line, filePath), filePath);
}

function readKanaSessionFile(filePath: string): {
  header: KanaSessionHeader;
  timeline: KanaSessionTimelineEntry[];
  recoveredIncompleteTail: boolean;
} {
  const { lines, recoveredIncompleteTail } = readSessionLines(filePath, true);
  const header = parseHeader(lines[0], filePath);
  const timeline: KanaSessionTimelineEntry[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    timeline.push(parseTimelineEntry(lines[index], filePath, index + 1));
  }

  return { header, timeline, recoveredIncompleteTail };
}

function getKanaSessionDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getKanaConfigPaths(env).sessionsPath, encodeKanaWorkspacePath(cwd));
}

function createSessionId(): string {
  return randomUUID();
}

function createEntryId(): string {
  return randomUUID();
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function headerToMetadata(header: KanaSessionHeader, filePath: string): KanaSessionMetadata {
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

function metadataToHeader(metadata: KanaSessionMetadata): KanaSessionHeader {
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

function createMessageEntry(
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

function contextCheckpointToEntry(
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

function assertContextCheckpointForAppend(checkpoint: ContextCheckpoint): void {
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

function entryToContextCheckpoint(
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

function findUnresolvedToolCalls(messages: readonly Message[]): ToolCallContent[] {
  const unresolved = new Map<string, ToolCallContent>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "tool_call") {
          unresolved.set(content.id, structuredClone(content));
        }
      }
      continue;
    }
    if (message.role === "tool") {
      unresolved.delete(message.toolCallId);
    }
  }

  return [...unresolved.values()];
}

function normalizeSessionTitle(title: string | undefined, messages: Message[] = []): string {
  const normalizedTitle = title?.replace(/\s+/g, " ").trim();
  const normalized = normalizedTitle || normalizePromptTitle(findFirstPrompt(messages));

  if (!normalized) {
    return DEFAULT_SESSION_TITLE;
  }

  return normalized.length > MAX_SESSION_TITLE_LENGTH
    ? normalized.slice(0, MAX_SESSION_TITLE_LENGTH)
    : normalized;
}

function findFirstPrompt(messages: Message[]): string | undefined {
  return messages.find(
    (message): message is UserMessage => message.role === "user" && message.source !== "recovery",
  )?.content;
}

function normalizePromptTitle(prompt: string | undefined): string {
  return (prompt ?? "").replace(/\s+/g, " ").trim();
}

function readSessionLines(
  filePath: string,
  repairIncompleteTail = false,
): {
  lines: string[];
  recoveredIncompleteTail: boolean;
} {
  if (!existsSync(filePath)) {
    throw new Error(`Kana session file not found: ${filePath}`);
  }

  let content = readFileSync(filePath, "utf8");
  let recoveredIncompleteTail = false;

  if (repairIncompleteTail && content.length > 0 && !content.endsWith("\n")) {
    const lastNewline = content.lastIndexOf("\n");
    const tail = content.slice(lastNewline + 1);

    try {
      JSON.parse(tail);
      // A complete record can reach disk before its trailing newline. Add the
      // delimiter before any later append so two records cannot be joined.
      appendFileSync(filePath, "\n", { encoding: "utf8", mode: 0o600 });
      content += "\n";
    } catch {
      if (lastNewline < 0) {
        throw new Error(`Kana session header is incomplete: ${filePath}`);
      }
      // Only an unterminated final record is recoverable. Corruption in any
      // completed JSONL record continues to fail normal parsing.
      truncateSync(filePath, lastNewline + 1);
      content = content.slice(0, lastNewline + 1);
      recoveredIncompleteTail = true;
    }
  }

  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error(`Kana session file is empty: ${filePath}`);
  }

  return {
    lines,
    recoveredIncompleteTail,
  };
}

function parseHeader(line: string, filePath: string): KanaSessionHeader {
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

function parseTimelineEntry(
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

  const role = (value as Record<string, unknown>).role;
  return role === "user" || role === "assistant" || role === "tool";
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

function listDirectories(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}
