import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import path from "node:path";
import {
  createKanaSession,
  deleteKanaSession,
  KanaSessionInUseError,
  type KanaSessionMetadata,
  loadKanaSession,
  openKanaSession,
} from "../../../src/kana/session";
import { messageIdentityForTest } from "../../helpers/messages";
import { appendSessionSnapshot } from "../../helpers/session";
import { createSessionFixture } from "./session-fixture";

const { cleanupTempDirs, createTempEnv } = createSessionFixture();

// The owner leaves a turn open with a pending tool call and an unterminated
// tail, exactly what a competing load would otherwise recover and truncate.
const OWNER_SOURCE = `
  import { appendFileSync } from "node:fs";
  import { createMessageIdentity } from "./src/core/index.ts";
  import { createKanaSessionJournal, openKanaSession } from "./src/kana/session/index.ts";
  const [sessionId, cwd] = process.argv.slice(-2);
  const { session } = openKanaSession(sessionId, { cwd });
  const journal = createKanaSessionJournal(session.metadata, session.timeline);
  journal.startTurn("running-turn", [{
    ...createMessageIdentity({ kind: "user_input" }), role: "user", content: "Keep working.",
  }]);
  journal.appendMessage("running-turn", {
    ...createMessageIdentity({ kind: "model_output" }), role: "assistant",
    content: [{ type: "tool_call", id: "call-1", name: "bash", args: { command: "sleep 60" } }],
  });
  appendFileSync(session.metadata.path, '{"type":"message"');
  process.send("ready");
  process.on("message", () => process.exit(0));
`;

afterEach(() => {
  cleanupTempDirs();
});

describe("Kana session ownership", () => {
  test("rejects competing resume and deletion until the owning process exits", async () => {
    const env = createTempEnv();
    const owned = createPersistedSession(env, "owned");
    const other = createPersistedSession(env, "other");
    const owner = await startOwner(owned, env);

    try {
      const contentWhileOwned = readFileSync(owned.path, "utf8");
      expect(() => openKanaSession(owned.id, { cwd: owned.cwd, env })).toThrow(
        KanaSessionInUseError,
      );
      expect(() => loadKanaSession(owned.id, { cwd: owned.cwd, env })).toThrow(
        KanaSessionInUseError,
      );
      expect(() => deleteKanaSession(owned.id, { cwd: owned.cwd, env })).toThrow(
        KanaSessionInUseError,
      );
      expect(readFileSync(owned.path, "utf8")).toBe(contentWhileOwned);

      const independent = openKanaSession(other.id, { cwd: other.cwd, env });
      independent.ownership.release();
    } finally {
      owner.send("exit");
      await owner.exited;
    }

    const resumed = loadKanaSession(owned.id, { cwd: owned.cwd, env });
    expect(resumed.recoveredIncompleteTail).toBe(true);
    expect(resumed.recoveredInterruptedTurn).toEqual({
      turnId: "running-turn",
      unknownToolCallCount: 1,
    });
    expect(deleteKanaSession(owned.id, { cwd: owned.cwd, env })).toBe(true);
  });

  test("lets a later process take over a crashed owner's stale lock", async () => {
    const env = createTempEnv();
    const session = createPersistedSession(env, "crashed");
    const owner = await startOwner(session, env);
    owner.kill("SIGKILL");
    await owner.exited;

    const lockPath = `${session.path}.lock`;
    expect(existsSync(lockPath)).toBe(true);
    expect(() => openKanaSession(session.id, { cwd: session.cwd, env })).toThrow(
      KanaSessionInUseError,
    );
    // A dead owner stops refreshing the lock; age it past the stale threshold.
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    const resumed = openKanaSession(session.id, { cwd: session.cwd, env });
    resumed.ownership.release();
    expect(resumed.session.recoveredInterruptedTurn?.turnId).toBe("running-turn");
  });
});

function createPersistedSession(env: NodeJS.ProcessEnv, id: string): KanaSessionMetadata {
  const session = createKanaSession({ cwd: process.cwd(), env, id });
  appendSessionSnapshot(session, [
    { ...messageIdentityForTest("user"), role: "user", content: `Persist ${id}.` },
  ]);
  return session;
}

async function startOwner(session: KanaSessionMetadata, env: NodeJS.ProcessEnv) {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const child = Bun.spawn([process.execPath, "-e", OWNER_SOURCE, session.id, session.cwd], {
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      if (message === "ready") markReady();
    },
  });
  await Promise.race([
    ready,
    child.exited.then((code) => {
      throw new Error(`Session owner exited before it was ready: ${code}`);
    }),
  ]);
  return child;
}
