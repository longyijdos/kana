import { describe, expect, test } from "bun:test";
import {
  KanaSubagentManager,
  type KanaSubagentProfile,
  type KanaSubagentRunResult,
} from "../../../src/kana/subagents";

describe("Kana subagent manager", () => {
  test("starts immediately, enforces the live limit, and supports bounded waiting", async () => {
    const manager = new KanaSubagentManager();
    const client = manager.bind(
      manager.createOwner({ sessionId: "session-1", cwd: process.cwd(), persistent: false }),
      { maxLive: 1 },
    );
    const run = deferred<KanaSubagentRunResult>();
    const started = client.start({
      profile: profile(),
      task: "Inspect the parser",
      spawnToolCallId: "call-spawn",
      run: () => run.promise,
    });

    expect(started.status).toBe("running");
    expect(started.id).toStartWith("agent_");
    expect(() =>
      client.start({
        profile: profile(),
        task: "A second task",
        spawnToolCallId: "call-second",
        run: () => Promise.resolve(result("second")),
      }),
    ).toThrow("Subagent limit reached (1/1).");
    await expect(client.wait(started.id, { waitMs: 1 })).resolves.toMatchObject({
      status: "running",
      waitTimedOut: true,
    });

    run.resolve(result("parser result"));
    await expect(client.wait(started.id, { waitMs: 100 })).resolves.toMatchObject({
      status: "completed",
      output: "parser result",
      waitTimedOut: false,
    });
  });

  test("routes parent cancellation to the owned child and isolates owners", async () => {
    const manager = new KanaSubagentManager();
    const firstOwner = manager.createOwner({
      sessionId: "session-1",
      cwd: process.cwd(),
      persistent: false,
    });
    const secondOwner = manager.createOwner({
      sessionId: "session-1",
      cwd: process.cwd(),
      persistent: false,
    });
    const first = manager.bind(firstOwner, { maxLive: 1 });
    const second = manager.bind(secondOwner, { maxLive: 1 });
    const parent = new AbortController();
    const started = first.start({
      profile: profile(),
      task: "Wait for cancellation",
      spawnToolCallId: "call-spawn",
      parentSignal: parent.signal,
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(result("cancelled late")), {
            once: true,
          });
        }),
    });

    expect(second.inspect(started.id)).toBeUndefined();
    await expect(second.wait(started.id)).resolves.toMatchObject({ status: "unknown" });

    parent.abort();
    await expect(first.wait(started.id, { waitMs: 100 })).resolves.toMatchObject({
      status: "cancelled",
      waitTimedOut: false,
    });
  });
});

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

function result(output: string): KanaSubagentRunResult {
  return {
    status: "completed",
    output,
    messages: [],
    terminalReason: "stop",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
