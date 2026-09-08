import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import type { AgentEndReason, AgentJournal } from "@/agent";
import type { Message } from "@/core";
import { encodeKanaWorkspacePath, getKanaConfigPaths } from "../path";
import {
  createKanaSessionJournal,
  type KanaSessionMetadata,
  type KanaSessionTurnOutcome,
  loadKanaSessionFile,
} from "../session";
import type { KanaSubagentInspection, KanaSubagentOwner } from "./manager";
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

export function loadKanaSubagentInspections(
  owner: KanaSubagentOwner,
  env: NodeJS.ProcessEnv = process.env,
): KanaSubagentInspection[] {
  if (!owner.persistent) return [];
  const directory = getKanaSubagentDirectory(owner.cwd, owner.sessionId, env);
  if (!existsSync(directory)) return [];
  const inspections: KanaSubagentInspection[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    try {
      const loaded = loadKanaSessionFile(path.join(directory, entry.name), {
        recoverInterruptedTurn: false,
      });
      const identity = loaded.metadata.subagent;
      if (!identity || identity.parentSessionId !== owner.sessionId) continue;
      const end = [...loaded.timeline].reverse().find((item) => item.type === "turn_end");
      const outcome = end?.type === "turn_end" ? end.outcome : "interrupted";
      inspections.push({
        id: loaded.metadata.id,
        profile: identity.profile.name,
        label: loaded.metadata.title,
        status: statusFromOutcome(outcome),
        startedAt: new Date(loaded.metadata.createdAt),
        ...(end === undefined ? {} : { finishedAt: new Date(end.timestamp) }),
        ...(loaded.metadata.model === undefined
          ? {}
          : {
              model: {
                provider: loaded.metadata.model.provider,
                model: loaded.metadata.model.model,
              },
            }),
        ...(isAgentEndReason(outcome) ? { terminalReason: outcome } : {}),
        output: finalOutput(loaded.messages),
        ...(outcome === "error" ? { error: "Subagent run failed." } : {}),
        waitTimedOut: false,
        task: loaded.messages.find((message) => message.role === "user")?.content ?? "",
        messages: loaded.messages,
      });
    } catch {
      // A malformed child journal does not hide the remaining session records.
    }
  }
  return inspections.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
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

function statusFromOutcome(outcome: KanaSessionTurnOutcome | "interrupted") {
  if (outcome === "interrupted") return "interrupted" as const;
  if (outcome === "aborted") return "cancelled" as const;
  if (outcome === "error") return "errored" as const;
  return "completed" as const;
}

function isAgentEndReason(value: KanaSessionTurnOutcome): value is AgentEndReason {
  return value !== "interrupted" && value !== "snapshot";
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 120);
}
