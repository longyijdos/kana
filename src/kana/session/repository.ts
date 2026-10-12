import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
} from "node:fs";
import path from "node:path";

import type { ContextCheckpoint } from "@/agent";
import type { Message } from "@/core";
import { encodeKanaWorkspacePath, fileNameTimestamp, getKanaConfigPaths } from "../path";
import {
  type CreateKanaSessionOptions,
  entryToContextCheckpoint,
  type FindKanaSessionOptions,
  headerToMetadata,
  type KanaSessionHeader,
  type KanaSessionMetadata,
  type KanaSessionTimelineEntry,
  type LoadKanaSessionResult,
  normalizeSessionTitle,
  parseHeader,
  parseTimelineEntry,
  SESSION_VERSION,
} from "./format";
import { createKanaSessionJournal } from "./journal";
import { acquireKanaSessionOwnership, type KanaSessionOwnership } from "./ownership";

type OpenedKanaSession = {
  session: LoadKanaSessionResult;
  ownership: KanaSessionOwnership;
};

export function createKanaSession(options: CreateKanaSessionOptions = {}): KanaSessionMetadata {
  const id = options.id ?? randomUUID();
  const createdAt = new Date().toISOString();
  const cwd = options.cwd ?? process.cwd();
  const sessionDir = getKanaSessionDir(cwd, options.env);
  const filePath = path.join(sessionDir, `${fileNameTimestamp(createdAt)}_${id}.jsonl`);
  const header: KanaSessionHeader = {
    type: "session",
    version: SESSION_VERSION,
    id,
    createdAt,
    title: options.title === undefined ? "" : normalizeSessionTitle(options.title),
    cwd,
    parentSessionPath: options.parentSessionPath,
    subagent: options.subagent,
  };

  return headerToMetadata(header, filePath, createdAt);
}

// Loading may repair the tail or recover an interrupted turn, so it writes only
// after acquiring ownership. The caller keeps it for every later append.
export function openKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions = {},
): OpenedKanaSession {
  const metadata = findKanaSession(sessionId, options);

  if (!metadata) {
    throw new Error(`Kana session not found: ${sessionId}`);
  }

  const ownership = acquireKanaSessionOwnership(metadata);
  try {
    return { session: loadKanaSessionFile(metadata.path), ownership };
  } catch (error) {
    ownership.release();
    throw error;
  }
}

export function loadKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions = {},
): LoadKanaSessionResult {
  const { session, ownership } = openKanaSession(sessionId, options);
  ownership.release();
  return session;
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

  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function deleteKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions = {},
): boolean {
  const metadata = findKanaSession(sessionId, options);

  if (!metadata) {
    return false;
  }

  const ownership = acquireKanaSessionOwnership(metadata);
  try {
    rmSync(metadata.path, { force: true });
    rmSync(path.join(getKanaSessionDir(metadata.cwd, options.env), ".subagents", metadata.id), {
      recursive: true,
      force: true,
    });
  } finally {
    ownership.release();
  }
  return true;
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

  const initialMetadata = headerToMetadata(
    parsed.header,
    filePath,
    deriveUpdatedAt(parsed.timeline, parsed.header.createdAt),
  );
  const initialJournal = createKanaSessionJournal(initialMetadata, parsed.timeline);
  if (initialJournal.activeTurnId) {
    const recovered = initialJournal.recoverInterruptedTurn();
    recoveredInterruptedTurn = {
      turnId: recovered.turnId,
      unknownToolCallCount: recovered.unknownToolCallCount,
    };
    parsed = readKanaSessionFile(filePath);
  }

  const metadata = headerToMetadata(
    parsed.header,
    filePath,
    deriveUpdatedAt(parsed.timeline, parsed.header.createdAt),
  );
  // Validate ordering and references before exposing any recovered state.
  createKanaSessionJournal(metadata, parsed.timeline);
  const messages: Message[] = [];
  const messageIds = new Map<string, number>();
  const compactionIds = new Set<string>();
  let contextCheckpoint: ContextCheckpoint | undefined;
  let todoState = [] as LoadKanaSessionResult["todoState"];

  for (const entry of parsed.timeline) {
    if (entry.type === "message") {
      messages.push(entry.message);
      messageIds.set(entry.id, messages.length);
      continue;
    }
    if (entry.type === "todo_state") {
      todoState = entry.items;
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
    timeline: parsed.timeline,
    todoState,
    contextCheckpoint,
    recoveredInterruptedTurn,
    recoveredIncompleteTail: recoveredIncompleteTail || undefined,
  };
}

function loadKanaSessionMetadata(filePath: string): KanaSessionMetadata {
  const { headerLine, recordLines } = readSessionLines(filePath);
  const header = parseHeader(headerLine, filePath);
  return headerToMetadata(
    header,
    filePath,
    readLastEntryTimestamp(recordLines) ?? header.createdAt,
  );
}

function deriveUpdatedAt(timeline: readonly KanaSessionTimelineEntry[], createdAt: string): string {
  return timeline.at(-1)?.timestamp ?? createdAt;
}

// Only complete records count as activity: an unterminated or malformed tail
// must not reorder sessions in the picker.
function readLastEntryTimestamp(recordLines: readonly string[]): string | undefined {
  for (const line of [...recordLines].reverse()) {
    const timestamp = readRecordTimestamp(line);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }
  return undefined;
}

function readRecordTimestamp(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    const timestamp = (parsed as { timestamp?: unknown }).timestamp;
    return typeof timestamp === "string" ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function readKanaSessionFile(filePath: string): {
  header: KanaSessionHeader;
  timeline: readonly KanaSessionTimelineEntry[];
  recoveredIncompleteTail: boolean;
} {
  const { headerLine, recordLines, recoveredIncompleteTail } = readSessionLines(filePath, true);
  return {
    header: parseHeader(headerLine, filePath),
    timeline: recordLines.map((line, index) => parseTimelineEntry(line, filePath, index + 2)),
    recoveredIncompleteTail,
  };
}

function getKanaSessionDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getKanaConfigPaths(env).sessionsPath, encodeKanaWorkspacePath(cwd));
}

function readSessionLines(
  filePath: string,
  repairIncompleteTail = false,
): {
  headerLine: string;
  recordLines: string[];
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

  const [headerLine, ...recordLines] = content.split("\n").filter((line) => line.trim());
  if (headerLine === undefined) {
    throw new Error(`Kana session file is empty: ${filePath}`);
  }
  return { headerLine, recordLines, recoveredIncompleteTail };
}

function listDirectories(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}
