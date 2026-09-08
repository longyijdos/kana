import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentJournal } from "@/agent";
import type { Message } from "@/core";
import { appendKanaSessionMessages, createKanaSession, deleteKanaSession } from "@/kana";
import {
  createKanaSubagentJournal,
  getKanaSubagentDirectory,
  type KanaSubagentOwner,
  type KanaSubagentProfile,
  loadKanaSubagentInspections,
} from "../../../src/kana/subagents";
import { messageIdentityForTest } from "../../helpers/messages";
import { createSessionFixture } from "../session/session-fixture";

const { cleanupTempDirs, createTempEnv } = createSessionFixture();

afterEach(cleanupTempDirs);

describe("Kana subagent journal repository", () => {
  test("persists a profile snapshot and transcript outside the normal session list", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const owner = createOwner(cwd);
    const journal = createJournal(owner, env, "agent_complete");
    const user = userMessage("Inspect the parser");
    const assistant = assistantMessage("The parser is correct.");

    journal.startRun({ runId: "run-1", messages: [user] });
    journal.appendMessage({ runId: "run-1", message: assistant });
    journal.endRun({ runId: "run-1", reason: "stop" });

    expect(loadKanaSubagentInspections(owner, env)).toEqual([
      expect.objectContaining({
        id: "agent_complete",
        profile: "explorer",
        status: "completed",
        task: "Inspect the parser",
        output: "The parser is correct.",
        messages: [user, assistant],
      }),
    ]);
  });

  test("reports an incomplete child as interrupted without repairing its journal", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const owner = createOwner(cwd);
    const journal = createJournal(owner, env, "agent_interrupted");
    journal.startRun({ runId: "run-1", messages: [userMessage("Keep this open")] });
    const directory = getKanaSubagentDirectory(cwd, owner.sessionId, env);
    const filePath = path.join(directory, fileName(directory));
    const before = readFileSync(filePath, "utf8");

    const [inspection] = loadKanaSubagentInspections(owner, env);

    expect(inspection?.status).toBe("interrupted");
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });

  test("deleting a parent session removes its child journals", () => {
    const env = createTempEnv();
    const cwd = path.join(env.HOME ?? "", "repo");
    const parent = createKanaSession({ cwd, env, id: "session-1" });
    appendKanaSessionMessages(parent, [userMessage("Persist the parent")]);
    const owner = createOwner(cwd);
    const journal = createJournal(owner, env, "agent_child");
    journal.startRun({ runId: "run-1", messages: [userMessage("Child")] });
    journal.endRun({ runId: "run-1", reason: "stop" });
    const directory = getKanaSubagentDirectory(cwd, owner.sessionId, env);

    expect(existsSync(directory)).toBe(true);
    expect(deleteKanaSession(parent.id, { cwd, env })).toBe(true);
    expect(existsSync(directory)).toBe(false);
  });
});

function createOwner(cwd: string): KanaSubagentOwner {
  return {
    sessionId: "session-1",
    instanceId: "owner-1",
    cwd,
    persistent: true,
  };
}

function createJournal(
  owner: KanaSubagentOwner,
  env: NodeJS.ProcessEnv,
  agentId: string,
): AgentJournal {
  const journal = createKanaSubagentJournal({
    agentId,
    owner,
    profile: profile(),
    task: "Inspect the parser",
    spawnToolCallId: "call-spawn",
    model: { provider: "deepseek", model: "deepseek-v4-pro" },
    env,
  });
  if (!journal) throw new Error("Expected a persistent journal.");
  return journal;
}

function profile(): KanaSubagentProfile {
  return {
    name: "explorer",
    description: "Explore",
    instructions: "Inspect only.",
    tools: ["read"],
    source: "builtin",
    digest: "profile-digest",
  };
}

function userMessage(content: string): Extract<Message, { role: "user" }> {
  return { ...messageIdentityForTest("user"), role: "user", content };
}

function assistantMessage(content: string): Extract<Message, { role: "assistant" }> {
  return {
    ...messageIdentityForTest("assistant"),
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: content }],
  };
}

function fileName(directory: string): string {
  const glob = new Bun.Glob("*.jsonl");
  const [file] = [...glob.scanSync(directory)];
  if (!file) throw new Error("Expected a subagent journal file.");
  return file;
}
