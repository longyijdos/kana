import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { ContextCheckpoint } from "@/agent";
import type { Message, ModelMetadata, ModelUsage } from "@/core";
import { getKanaConfigPaths } from "./config";
import { encodeKanaWorkspacePath } from "./path";

const SESSION_VERSION = 2;
const SUPPORTED_SESSION_VERSIONS = [1, SESSION_VERSION] as const;
const CONTEXT_SUMMARY_FORMAT = "kana-context-summary-v1";
const DEFAULT_SESSION_TITLE = "Untitled session";
const MAX_SESSION_TITLE_LENGTH = 80;

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
  version: (typeof SUPPORTED_SESSION_VERSIONS)[number];
  id: string;
  createdAt: string;
  title: string;
  cwd: string;
  model?: KanaSessionModelMetadata;
  parentSessionPath?: string;
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

export type KanaSessionTimelineEntry = KanaSessionMessageEntry | KanaSessionContextCompactionEntry;

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
};

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
        // Ignore malformed session files when listing so one bad file does not
        // hide the rest of the local history.
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
  const compactions = structuredClone(options.compactions ?? []);
  for (const checkpoint of compactions) {
    assertContextCheckpointForAppend(checkpoint);
  }
  compactions.sort((left, right) => left.createdAfterMessageCount - right.createdAfterMessageCount);
  if (messages.length === 0 && compactions.length === 0) {
    return [];
  }

  const timestamp = options.timestamp ?? new Date().toISOString();
  const sessionExists = existsSync(session.path);
  const parsed = sessionExists ? readKanaSessionFile(session.path) : undefined;
  const existingTimeline = parsed?.timeline ?? [];
  const messageEntries = existingTimeline.filter(
    (entry): entry is KanaSessionMessageEntry => entry.type === "message",
  );
  const existingCompactionIds = new Set(
    existingTimeline
      .filter(
        (entry): entry is KanaSessionContextCompactionEntry => entry.type === "context_compaction",
      )
      .map((entry) => entry.id),
  );
  let messageCount = messageEntries.length;
  let parentId = existingTimeline.at(-1)?.id ?? null;
  let content = "";
  const appended: KanaSessionTimelineEntry[] = [];

  if (!sessionExists) {
    session.title = normalizeSessionTitle(session.title, messages);
    content = `${JSON.stringify(metadataToHeader(session))}\n`;
  } else if (compactions.length > 0 && parsed?.header.version === 1) {
    upgradeKanaSessionFile(session.path, parsed.header);
  }

  const messageIds = messageEntries.map((entry) => entry.id);
  let compactionIndex = 0;
  // A checkpoint is appended at the time compaction happened, while its
  // coversThroughId can point further back. Interleave by message count so a
  // resumed TUI reproduces the live marker position without deleting history.
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
      const entry = contextCheckpointToEntry(
        checkpoint,
        parentId,
        messageIds,
        existingCompactionIds,
      );
      content += `${JSON.stringify(entry)}\n`;
      appended.push(entry);
      parentId = entry.id;
      existingCompactionIds.add(entry.id);
      compactionIndex += 1;
    }
  };

  appendEligibleCompactions();
  for (const message of messages) {
    const entry: KanaSessionMessageEntry = {
      type: "message",
      id: createEntryId(),
      parentId,
      timestamp,
      message: structuredClone(message),
    };

    content += `${JSON.stringify(entry)}\n`;
    appended.push(entry);
    parentId = entry.id;
    messageIds.push(entry.id);
    messageCount += 1;
    appendEligibleCompactions();
  }

  if (compactionIndex !== compactions.length) {
    throw new Error("Context compaction references messages that have not been persisted.");
  }

  mkdirSync(path.dirname(session.path), { recursive: true });
  appendFileSync(session.path, content, {
    encoding: "utf8",
    mode: 0o600,
  });
  return appended;
}

function findKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions,
): KanaSessionMetadata | undefined {
  return listKanaSessions(options).find((session) => session.id === sessionId);
}

function loadKanaSessionFile(filePath: string): LoadKanaSessionResult {
  const { header, timeline } = readKanaSessionFile(filePath);
  const messages: Message[] = [];
  const messageIds = new Map<string, number>();
  const compactionIds = new Set<string>();
  let contextCheckpoint: ContextCheckpoint | undefined;

  for (const entry of timeline) {
    if (entry.type === "message") {
      messages.push(entry.message);
      messageIds.set(entry.id, messages.length);
      continue;
    }

    const coveredMessageCount = messageIds.get(entry.coversThroughId);
    if (coveredMessageCount === undefined) {
      throw new Error(
        `Kana session compaction references an unknown message: ${filePath}:${entry.id}`,
      );
    }
    if (entry.baseCompactionId && !compactionIds.has(entry.baseCompactionId)) {
      throw new Error(
        `Kana session compaction references an unknown checkpoint: ${filePath}:${entry.id}`,
      );
    }

    contextCheckpoint = entryToContextCheckpoint(entry, coveredMessageCount, messages.length);
    compactionIds.add(entry.id);
  }

  return {
    metadata: headerToMetadata(header, filePath),
    messages,
    timeline: structuredClone(timeline),
    contextCheckpoint,
  };
}

function loadKanaSessionMetadata(filePath: string): KanaSessionMetadata {
  const [line] = readSessionLines(filePath);
  return headerToMetadata(parseHeader(line, filePath), filePath);
}

function readKanaSessionFile(filePath: string): {
  header: KanaSessionHeader;
  timeline: KanaSessionTimelineEntry[];
} {
  const lines = readSessionLines(filePath);
  const header = parseHeader(lines[0], filePath);
  const timeline: KanaSessionTimelineEntry[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    timeline.push(parseTimelineEntry(lines[index], filePath, index + 1, header.version));
  }

  return { header, timeline };
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
    (checkpoint.reason !== "threshold" && checkpoint.reason !== "provider_limit") ||
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

function upgradeKanaSessionFile(filePath: string, header: KanaSessionHeader): void {
  const lines = readSessionLines(filePath);
  const upgradedHeader: KanaSessionHeader = {
    ...header,
    version: SESSION_VERSION,
  };
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    // Existing v1 sessions remain append-only until their first checkpoint.
    // Upgrade the header atomically before introducing the v2 entry type.
    writeFileSync(
      temporaryPath,
      `${[JSON.stringify(upgradedHeader), ...lines.slice(1)].join("\n")}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
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
  return messages.find((message) => message.role === "user")?.content;
}

function normalizePromptTitle(prompt: string | undefined): string {
  return (prompt ?? "").replace(/\s+/g, " ").trim();
}

function readSessionLines(filePath: string): string[] {
  if (!existsSync(filePath)) {
    throw new Error(`Kana session file not found: ${filePath}`);
  }

  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error(`Kana session file is empty: ${filePath}`);
  }

  return lines;
}

function parseHeader(line: string, filePath: string): KanaSessionHeader {
  const parsed = parseJsonRecord(line, filePath, 1);

  if (
    parsed.type !== "session" ||
    !SUPPORTED_SESSION_VERSIONS.includes(
      parsed.version as (typeof SUPPORTED_SESSION_VERSIONS)[number],
    ) ||
    typeof parsed.id !== "string" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.title !== "string" ||
    typeof parsed.cwd !== "string"
  ) {
    throw new Error(`Invalid Kana session header: ${filePath}`);
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
  version: KanaSessionHeader["version"],
): KanaSessionTimelineEntry {
  const parsed = parseJsonRecord(line, filePath, lineNumber);

  if (parsed.type === "message") {
    if (
      typeof parsed.id !== "string" ||
      (parsed.parentId !== null && typeof parsed.parentId !== "string") ||
      typeof parsed.timestamp !== "string" ||
      !isMessage(parsed.message)
    ) {
      throw new Error(`Invalid Kana session message entry: ${filePath}:${lineNumber}`);
    }

    return parsed as KanaSessionMessageEntry;
  }

  if (parsed.type === "context_compaction" && version === SESSION_VERSION) {
    if (!isContextCompactionEntry(parsed)) {
      throw new Error(`Invalid Kana session compaction entry: ${filePath}:${lineNumber}`);
    }

    return parsed;
  }

  if (parsed.type === "context_compaction") {
    throw new Error(`Kana session v1 cannot contain compaction entries: ${filePath}:${lineNumber}`);
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

function isContextCompactionEntry(
  value: Record<string, unknown>,
): value is KanaSessionContextCompactionEntry {
  const summary = value.summary;

  return (
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string" &&
    (value.reason === "threshold" || value.reason === "provider_limit") &&
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
