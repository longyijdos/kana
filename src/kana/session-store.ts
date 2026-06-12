import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Message, ModelMetadata } from "@/core";
import { getKanaConfigPaths } from "./config";

const SESSION_VERSION = 1;

export type KanaSessionModelMetadata = Pick<ModelMetadata, "provider" | "model">;

export type KanaSessionMetadata = {
  id: string;
  createdAt: string;
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

export type KanaSessionEntry = KanaSessionHeader | KanaSessionMessageEntry;

export type CreateKanaSessionOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  id?: string;
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

export type LoadKanaSessionResult = {
  metadata: KanaSessionMetadata;
  messages: Message[];
};

export function createKanaSession(
  options: CreateKanaSessionOptions = {},
): KanaSessionMetadata {
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

export function listKanaSessions(
  options: FindKanaSessionOptions = {},
): KanaSessionMetadata[] {
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

  return sessions.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

export function appendKanaSessionMessages(
  session: KanaSessionMetadata,
  messages: Message[],
  options: AppendKanaSessionMessagesOptions = {},
): void {
  if (messages.length === 0) {
    return;
  }

  const timestamp = options.timestamp ?? new Date().toISOString();
  const sessionExists = existsSync(session.path);
  let parentId = sessionExists ? loadKanaSessionLeafId(session.path) : null;
  let content = sessionExists ? "" : `${JSON.stringify(metadataToHeader(session))}\n`;

  for (const message of messages) {
    const entry: KanaSessionMessageEntry = {
      type: "message",
      id: createEntryId(),
      parentId,
      timestamp,
      message: structuredClone(message),
    };

    content += `${JSON.stringify(entry)}\n`;
    parentId = entry.id;
  }

  mkdirSync(path.dirname(session.path), { recursive: true });
  appendFileSync(session.path, content, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function findKanaSession(
  sessionId: string,
  options: FindKanaSessionOptions,
): KanaSessionMetadata | undefined {
  return listKanaSessions(options).find((session) => session.id === sessionId);
}

function loadKanaSessionFile(filePath: string): LoadKanaSessionResult {
  const lines = readSessionLines(filePath);
  const header = parseHeader(lines[0], filePath);
  const messages: Message[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const entry = parseMessageEntry(lines[index], filePath, index + 1);
    messages.push(entry.message);
  }

  return {
    metadata: headerToMetadata(header, filePath),
    messages,
  };
}

function loadKanaSessionMetadata(filePath: string): KanaSessionMetadata {
  const [line] = readSessionLines(filePath);
  return headerToMetadata(parseHeader(line, filePath), filePath);
}

function loadKanaSessionLeafId(filePath: string): string | null {
  const lines = readSessionLines(filePath);
  let leafId: string | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    leafId = parseMessageEntry(lines[index], filePath, index + 1).id;
  }

  return leafId;
}

function getKanaSessionDir(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getKanaConfigPaths(env).sessionsPath, encodeCwd(cwd));
}

function encodeCwd(cwd: string): string {
  return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
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

function headerToMetadata(
  header: KanaSessionHeader,
  filePath: string,
): KanaSessionMetadata {
  return {
    id: header.id,
    createdAt: header.createdAt,
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
    cwd: metadata.cwd,
    model: metadata.model,
    parentSessionPath: metadata.parentSessionPath,
  };
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
    parsed.version !== SESSION_VERSION ||
    typeof parsed.id !== "string" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.cwd !== "string"
  ) {
    throw new Error(`Invalid Kana session header: ${filePath}`);
  }

  if (parsed.model !== undefined && !isSessionModelMetadata(parsed.model)) {
    throw new Error(`Invalid Kana session model metadata: ${filePath}`);
  }
  if (
    parsed.parentSessionPath !== undefined &&
    typeof parsed.parentSessionPath !== "string"
  ) {
    throw new Error(`Invalid Kana session parent path: ${filePath}`);
  }

  return parsed as KanaSessionHeader;
}

function parseMessageEntry(
  line: string,
  filePath: string,
  lineNumber: number,
): KanaSessionMessageEntry {
  const parsed = parseJsonRecord(line, filePath, lineNumber);

  if (
    parsed.type !== "message" ||
    typeof parsed.id !== "string" ||
    (parsed.parentId !== null && typeof parsed.parentId !== "string") ||
    typeof parsed.timestamp !== "string" ||
    !isMessage(parsed.message)
  ) {
    throw new Error(`Invalid Kana session message entry: ${filePath}:${lineNumber}`);
  }

  return parsed as KanaSessionMessageEntry;
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

function isSessionModelMetadata(value: unknown): value is KanaSessionModelMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).provider === "string" &&
    typeof (value as Record<string, unknown>).model === "string"
  );
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const role = (value as Record<string, unknown>).role;
  return role === "user" || role === "assistant" || role === "tool";
}

function listDirectories(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}
