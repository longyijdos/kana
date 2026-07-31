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
import { getKanaConfigPaths } from "../config";
import { encodeKanaWorkspacePath } from "../path";
import {
  type AppendKanaSessionMessagesOptions,
  type AppendKanaSessionRunOptions,
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

export function createKanaSession(options: CreateKanaSessionOptions = {}): KanaSessionMetadata {
  const id = options.id ?? randomUUID();
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

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
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

function listDirectories(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}
