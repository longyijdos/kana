import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  createPersistentKanaSubagentArtifactStore,
  deleteKanaSessionArtifacts,
  forkKanaSessionArtifacts,
  getKanaSessionArtifactDirectory,
} from "../../../src/kana/artifacts";
import { getKanaSubagentArtifactParentDirectory } from "../../../src/kana/artifacts/store";
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
    const artifact = await sourceStore.saveText("complete forked output", "shell");
    const childStore = createPersistentKanaSubagentArtifactStore({
      parentSessionId: "source-session",
      agentId: "child-1",
      cwd,
      env,
    });
    const childArtifact = await childStore.saveText("child output", "shell");
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
    expect(existsSync(getKanaSubagentArtifactParentDirectory("target-session", cwd, env))).toBe(
      false,
    );
    expect(forkedMessage.artifact.locator).not.toBe(artifact.locator);
    expect(forkedMessage.content).toContain(forkedMessage.artifact.locator);
    expect(forkedMessage.content).not.toContain(artifact.locator);
    expect(forked.contextCheckpoint?.summary).toContain(forkedMessage.artifact.locator);
    expect(forked.contextCheckpoint?.summary).not.toContain(artifact.locator);
    expect(readFileSync(forkedMessage.artifact.locator, "utf8")).toBe("complete forked output");

    expect(deleteKanaSessionArtifacts({ sessionId: "source-session", cwd, env })).toMatchObject({
      removedDirectoryCount: 2,
      failures: [],
    });
    expect(existsSync(artifact.locator)).toBe(false);
    expect(existsSync(childArtifact.locator)).toBe(false);
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
    const referenced = await referencedStore.saveText("referenced", "shell");
    const unreferenced = await referencedStore.saveText("unreferenced", "shell");
    const orphanStore = createPersistentKanaSessionArtifactStore({
      sessionId: "orphan-session",
      cwd,
      env,
    });
    const orphan = await orphanStore.saveText("orphaned", "shell");
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

  test("stores children in mirrored directories and deletes them even without parent artifacts", async () => {
    const { cwd, env } = createFixture();
    const store = createPersistentKanaSubagentArtifactStore({
      parentSessionId: "parent-session",
      agentId: "child-1",
      cwd,
      env,
    });
    const artifact = await store.saveText("child output", "shell");
    const sibling = await createPersistentKanaSubagentArtifactStore({
      parentSessionId: "other-session",
      agentId: "child-2",
      cwd,
      env,
    }).saveText("keep other session", "shell");
    expect(path.dirname(artifact.locator)).toBe(
      path.join(
        getKanaConfigPaths(env).artifactsPath,
        encodeKanaWorkspacePath(cwd),
        ".subagents",
        "parent-session",
        "child-1",
      ),
    );
    await store.close();
    expect(readFileSync(artifact.locator, "utf8")).toBe("child output");
    expect(existsSync(getKanaSessionArtifactDirectory("parent-session", cwd, env))).toBe(false);

    expect(deleteKanaSessionArtifacts({ sessionId: "parent-session", cwd, env })).toEqual({
      removedDirectoryCount: 1,
      removedFileCount: 0,
      failures: [],
    });
    expect(existsSync(artifact.locator)).toBe(false);
    expect(readFileSync(sibling.locator, "utf8")).toBe("keep other session");
  });

  test("cleans child artifacts against child journals while respecting parent ownership and grace periods", async () => {
    const { cwd, env } = createFixture();
    const childStore = (parentSessionId: string, agentId: string) =>
      createPersistentKanaSubagentArtifactStore({ parentSessionId, agentId, cwd, env });
    const retainedStore = childStore("parent-session", "retained-child");
    const retained = await retainedStore.saveText("referenced by child", "shell");
    const unreferenced = await retainedStore.saveText("not referenced by child", "shell");
    const recent = await retainedStore.saveText("recent output", "shell");
    const orphanChild = await childStore("parent-session", "orphan-child").saveText(
      "orphan",
      "shell",
    );
    const recentChild = await childStore("parent-session", "recent-child").saveText(
      "recent child",
      "shell",
    );
    const missingJournal = await childStore("journal-less-parent", "child").saveText(
      "missing child journal",
      "shell",
    );
    const orphanParent = await childStore("orphan-parent", "child").saveText(
      "missing parent journal",
      "shell",
    );
    const recentParent = await childStore("recent-parent", "child").saveText(
      "recent parent",
      "shell",
    );
    const sessionDirectory = path.join(
      getKanaConfigPaths(env).sessionsPath,
      encodeKanaWorkspacePath(cwd),
    );
    const childJournals = path.join(sessionDirectory, ".subagents", "parent-session");
    mkdirSync(childJournals, { recursive: true });
    writeFileSync(
      path.join(sessionDirectory, "2026-01-01_parent-session.jsonl"),
      `${JSON.stringify({ locator: unreferenced.locator })}\n`,
    );
    writeFileSync(path.join(sessionDirectory, "2026-01-01_journal-less-parent.jsonl"), "{}\n");
    writeFileSync(
      path.join(childJournals, "2026-01-01_retained-child.jsonl"),
      `${JSON.stringify({ locator: retained.locator })}\n`,
    );
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    for (const artifact of [retained, unreferenced, orphanChild, missingJournal, orphanParent]) {
      utimesSync(artifact.locator, old, old);
      utimesSync(path.dirname(artifact.locator), old, old);
    }
    utimesSync(getKanaSubagentArtifactParentDirectory("orphan-parent", cwd, env), old, old);
    utimesSync(
      path.dirname(getKanaSubagentArtifactParentDirectory("parent-session", cwd, env)),
      old,
      old,
    );

    expect(cleanupOrphanedKanaSessionArtifacts({ cwd, env })).toEqual({
      removedDirectoryCount: 3,
      removedFileCount: 1,
      failures: [],
    });
    for (const artifact of [retained, recent, recentChild, recentParent]) {
      expect(existsSync(artifact.locator)).toBe(true);
    }
    for (const artifact of [unreferenced, orphanChild, missingJournal, orphanParent]) {
      expect(existsSync(artifact.locator)).toBe(false);
    }
  });

  test("does not follow a symlinked child-artifact root during cleanup or deletion", async () => {
    const { cwd, env } = createFixture();
    const artifactRoot = path.join(
      getKanaConfigPaths(env).artifactsPath,
      encodeKanaWorkspacePath(cwd),
    );
    const outside = path.join(env.KANA_HOME ?? "", "outside");
    const parentDirectory = path.join(outside, "parent-session");
    mkdirSync(artifactRoot, { recursive: true });
    mkdirSync(parentDirectory, { recursive: true });
    const retained = path.join(parentDirectory, "keep.txt");
    writeFileSync(retained, "do not remove");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(parentDirectory, old, old);
    symlinkSync(outside, path.join(artifactRoot, ".subagents"));

    const cleanup = cleanupOrphanedKanaSessionArtifacts({ cwd, env });
    expect(cleanup.removedDirectoryCount).toBe(0);
    expect(cleanup.failures).toHaveLength(1);
    const deletion = deleteKanaSessionArtifacts({ sessionId: "parent-session", cwd, env });
    expect(deletion.removedDirectoryCount).toBe(0);
    expect(deletion.failures).toHaveLength(1);
    expect(readFileSync(retained, "utf8")).toBe("do not remove");
  });

  test("does not remove a pre-existing fork target during rollback", async () => {
    const { cwd, env } = createFixture();
    const sourceStore = createPersistentKanaSessionArtifactStore({
      sessionId: "source-session",
      cwd,
      env,
    });
    const sourceArtifact = await sourceStore.saveText("source", "shell");
    const targetStore = createPersistentKanaSessionArtifactStore({
      sessionId: "target-session",
      cwd,
      env,
    });
    const existingTargetArtifact = await targetStore.saveText("keep me", "shell");

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
    toolName: "shell",
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
