import type { Message, UserMessage } from "@/core";
import type { ContextCheckpoint } from "./context-manager";
import type { AgentEndReason } from "./events";

export type AgentJournal = {
  startRun(entry: { runId: string; messages: UserMessage[] }): Promise<void> | void;
  appendMessage(entry: { runId: string; message: Message }): Promise<void> | void;
  appendCompaction(entry: { runId?: string; compaction: ContextCheckpoint }): Promise<void> | void;
  endRun(entry: { runId: string; reason: AgentEndReason }): Promise<void> | void;
};
