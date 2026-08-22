import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ContextCheckpoint } from "@/agent";
import type { Message, ToolResultArtifact } from "@/core";
import { getKanaConfigPaths } from "@/kana";
import {
  auditKanaSessionArtifacts,
  cleanupOrphanedKanaSessionArtifacts,
  createPersistentKanaSessionArtifactStore,
  deleteKanaSessionArtifacts,
  forkKanaSessionArtifacts,
  getKanaSessionArtifactDirectory,
} from "../../../src/kana/artifacts";
import { encodeKanaWorkspacePath } from "../../../src/kana/path";
import { messageIdentityForTest } from "../../helpers/messages";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Kana session artifact lifecycle", () => {
  test("audits resume references and gives forks independent rewritten copies", async () => {
    const { cwd, env } = createFixture();
    const sourceStore = createPersistentKanaSessionArtifactStore({
      sessionId: "source-session",
      cwd,
      env,
    });
    const artifact = await sourceStore.saveText("complete forked output", "bash");
    const messages = [createArtifactMessage(artifact)];
    const checkpoint = createCheckpoint(`Retained locator: ${artifact.locator}`);

    expect(auditKanaSessionArtifacts({ messages, sessionId: "source-session", cwd, env })).toEqual({
      artifactCount: 1,
      missingCount: 0,
      invalidCount: 0,
    });

    const forked = forkKanaSessionArtifacts({
      messages,
      contextCheckpoint: checkpoint,
      sourceSessionId: "source-session",
      targetSessionId: "target-session",
      cwd,
      env,
    });
    const forkedMessage = forked.messages[0];
    if (forkedMessage?.role !== "tool" || !forkedMessage.artifact) {
      throw new Error("Fork did not retain artifact metadata.");
    }

    expect(forked.copiedArtifactCount).toBe(1);
    expect(forkedMessage.artifact.locator).not.toBe(artifact.locator);
    expect(forkedMessage.content).toContain(forkedMessage.artifact.locator);
    expect(forkedMessage.content).not.toContain(artifact.locator);
    expect(forked.contextCheckpoint?.summary).toContain(forkedMessage.artifact.locator);
    expect(forked.contextCheckpoint?.summary).not.toContain(artifact.locator);
    expect(readFileSync(forkedMessage.artifact.locator, "utf8")).toBe("complete forked output");

    expect(deleteKanaSessionArtifacts({ sessionId: "source-session", cwd, env })).toMatchObject({
      removedDirectoryCount: 1,
      failures: [],
    });
    expect(existsSync(artifact.locator)).toBe(false);
    expect(existsSync(forkedMessage.artifact.locator)).toBe(true);
    expect(
      auditKanaSessionArtifacts({
        messages: forked.messages,
        sessionId: "target-session",
        cwd,
        env,
      }),
    ).toEqual({ artifactCount: 1, missingCount: 0, invalidCount: 0 });

    rmSync(forkedMessage.artifact.locator);
    expect(
      auditKanaSessionArtifacts({
        messages: forked.messages,
        sessionId: "target-session",
        cwd,
        env,
      }),
    ).toEqual({ artifactCount: 1, missingCount: 1, invalidCount: 0 });
  });

  test("removes aged orphan directories and unreferenced files conservatively", async () => {
    const { cwd, env } = createFixture();
    const referencedStore = createPersistentKanaSessionArtifactStore({
      sessionId: "retained-session",
      cwd,
      env,
    });
    const referenced = await referencedStore.saveText("referenced", "bash");
    const unreferenced = await referencedStore.saveText("unreferenced", "bash");
    const orphanStore = createPersistentKanaSessionArtifactStore({
      sessionId: "orphan-session",
      cwd,
      env,
    });
    const orphan = await orphanStore.saveText("orphaned", "bash");
    const sessionDirectory = path.join(
      getKanaConfigPaths(env).sessionsPath,
      encodeKanaWorkspacePath(cwd),
    );
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      path.join(sessionDirectory, "2026-01-01_retained-session.jsonl"),
      `${JSON.stringify({ locator: referenced.locator })}\n`,
    );
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(referenced.locator, old, old);
    utimesSync(unreferenced.locator, old, old);
    utimesSync(orphan.locator, old, old);
    utimesSync(path.dirname(orphan.locator), old, old);

    const result = cleanupOrphanedKanaSessionArtifacts({ cwd, env });

    expect(result).toEqual({
      removedDirectoryCount: 1,
      removedFileCount: 1,
      failures: [],
    });
    expect(existsSync(referenced.locator)).toBe(true);
    expect(existsSync(unreferenced.locator)).toBe(false);
    expect(existsSync(getKanaSessionArtifactDirectory("orphan-session", cwd, env))).toBe(false);
  });

  test("does not remove a pre-existing fork target during rollback", async () => {
    const { cwd, env } = createFixture();
    const sourceStore = createPersistentKanaSessionArtifactStore({
      sessionId: "source-session",
      cwd,
      env,
    });
    const sourceArtifact = await sourceStore.saveText("source", "bash");
    const targetStore = createPersistentKanaSessionArtifactStore({
      sessionId: "target-session",
      cwd,
      env,
    });
    const existingTargetArtifact = await targetStore.saveText("keep me", "bash");

    expect(() =>
      forkKanaSessionArtifacts({
        messages: [createArtifactMessage(sourceArtifact)],
        sourceSessionId: "source-session",
        targetSessionId: "target-session",
        cwd,
        env,
      }),
    ).toThrow("Target session artifact directory already exists.");
    expect(readFileSync(existingTargetArtifact.locator, "utf8")).toBe("keep me");
  });
});

function createFixture(): { cwd: string; env: NodeJS.ProcessEnv } {
  const kanaHome = mkdtempSync(path.join(tmpdir(), "kana-artifact-lifecycle-"));
  tempDirectories.push(kanaHome);
  return {
    cwd: path.join(kanaHome, "workspace"),
    env: { KANA_HOME: kanaHome },
  };
}

function createArtifactMessage(artifact: ToolResultArtifact): Message {
  return {
    ...messageIdentityForTest("tool"),
    role: "tool",
    toolCallId: "call-1",
    toolName: "bash",
    content: `Preview\nFull output locator: ${artifact.locator}`,
    artifact: structuredClone(artifact),
    isError: false,
  };
}

function createCheckpoint(summary: string): ContextCheckpoint {
  return {
    id: "checkpoint-1",
    summary,
    coveredMessageCount: 1,
    createdAfterMessageCount: 1,
    compactedMessageCount: 1,
    reason: "threshold",
    beforeTokens: 1_000,
    estimatedAfterTokens: 100,
    createdAt: new Date().toISOString(),
  };
}
