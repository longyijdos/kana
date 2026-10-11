import { existsSync, readFileSync } from "node:fs";
import type { ContextCheckpoint } from "@/agent";
import type { Message } from "@/core";
import {
  type KanaSessionMetadata,
  type KanaSessionTimelineEntry,
  parseTimelineEntry,
} from "../../src/kana/session/format";
import { createKanaSessionJournal } from "../../src/kana/session/journal";

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

function readTimeline(filePath: string): KanaSessionTimelineEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  return lines.slice(1).map((line, index) => parseTimelineEntry(line, filePath, index + 2));
}
