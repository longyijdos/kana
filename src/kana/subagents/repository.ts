import path from "node:path";

import type { AgentJournal } from "@/agent";
import type { Message } from "@/core";
import { encodeKanaWorkspacePath, getKanaConfigPaths } from "../path";
import { createKanaSessionJournal, type KanaSessionMetadata } from "../session";
import type { KanaSubagentOwner } from "./manager";
import type { KanaSubagentProfile } from "./profiles";

export function createKanaSubagentJournal(options: {
  agentId: string;
  owner: KanaSubagentOwner;
  profile: KanaSubagentProfile;
  task: string;
  spawnToolCallId: string;
  model: { provider: string; model: string };
  env?: NodeJS.ProcessEnv;
}): AgentJournal | undefined {
  if (!options.owner.persistent) return undefined;
  const createdAt = new Date().toISOString();
  const directory = getKanaSubagentDirectory(
    options.owner.cwd,
    options.owner.sessionId,
    options.env,
  );
  const metadata: KanaSessionMetadata = {
    id: options.agentId,
    createdAt,
    title: `${options.profile.name}: ${singleLine(options.task)}`,
    cwd: options.owner.cwd,
    path: path.join(directory, `${safeTimestamp(createdAt)}_${options.agentId}.jsonl`),
    model: options.model,
    subagent: {
      parentSessionId: options.owner.sessionId,
      spawnToolCallId: options.spawnToolCallId,
      profile: structuredClone(options.profile),
    },
  };
  const journal = createKanaSessionJournal(metadata);
  return {
    startRun: ({ runId, messages }) => {
      journal.startTurn(runId, messages);
    },
    appendMessage: ({ runId, message }) => {
      journal.appendMessage(runId, message);
    },
    appendCompaction: ({ runId, compaction }) => {
      journal.appendCompaction(compaction, { turnId: runId });
    },
    endRun: ({ runId, reason }) => {
      journal.endTurn(runId, reason);
    },
  };
}

export function getKanaSubagentDirectory(
  cwd: string,
  parentSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    getKanaConfigPaths(env).sessionsPath,
    encodeKanaWorkspacePath(cwd),
    ".subagents",
    parentSessionId,
  );
}

export function finalOutput(messages: readonly Message[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") return "";
  return assistant.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("")
    .trim();
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 120);
}
