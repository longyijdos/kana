import { existsSync, readFileSync } from "node:fs";
import type { ContextCheckpoint } from "@/agent";
import type { Message } from "@/core";
import { listKanaSessions } from "../../src/kana/session";
import {
  type KanaSessionMetadata,
  type KanaSessionTimelineEntry,
  parseTimelineEntry,
} from "../../src/kana/session/format";
import { createKanaSessionJournal } from "../../src/kana/session/journal";
import type { KanaTodoItem } from "../../src/kana/todo";

export type AppendSessionSnapshotOptions = {
  timestamp?: string;
  compactions?: ContextCheckpoint[];
};

export function appendSessionSnapshot(
  session: KanaSessionMetadata,
  messages: readonly Message[],
  options: AppendSessionSnapshotOptions = {},
): readonly KanaSessionTimelineEntry[] {
  if (messages.length === 0 && (options.compactions?.length ?? 0) === 0) {
    return [];
  }
  return createKanaSessionJournal(session, readTimeline(session.path)).appendSnapshot(
    messages,
    options,
  );
}

// Reads a journal that a live host still owns, without ownership or recovery.
export function readOwnedSession(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): {
  messages: Message[];
  timeline: KanaSessionTimelineEntry[];
  todoState: readonly KanaTodoItem[];
} {
  const session = listKanaSessions({ cwd: process.cwd(), env }).find(
    (candidate) => candidate.id === sessionId,
  );
  if (!session) {
    throw new Error(`Test session not found: ${sessionId}`);
  }
  const timeline = readTimeline(session.path);
  return {
    timeline,
    messages: timeline.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    todoState:
      timeline.flatMap((entry) => (entry.type === "todo_state" ? [entry.items] : [])).at(-1) ?? [],
  };
}

function readTimeline(filePath: string): KanaSessionTimelineEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  return lines.slice(1).map((line, index) => parseTimelineEntry(line, filePath, index + 2));
}
