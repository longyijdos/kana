import { describe, expect, test } from "bun:test";
import {
  type KanaSubagentEvent,
  KanaSubagentManager,
  type KanaSubagentProfile,
  type KanaSubagentRunResult,
} from "../../../src/kana/subagents";
import { messageIdentityForTest } from "../../helpers/messages";

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

    const transcript = [
      {
        ...messageIdentityForTest("assistant"),
        role: "assistant" as const,
        stopReason: "stop" as const,
        content: [{ type: "text" as const, text: "parser result" }],
      },
    ];
    run.resolve({ ...result("parser result"), messages: transcript });
    await expect(client.wait(started.id, { waitMs: 100 })).resolves.toMatchObject({
      status: "completed",
      output: "parser result",
      waitTimedOut: false,
    });
    expect(client.context()).toEqual([]);
    expect(client.list()).toMatchObject([{ id: started.id, status: "completed" }]);
    expect(client.inspect(started.id)).toMatchObject({
      task: "Inspect the parser",
      output: "parser result",
      messages: transcript,
    });
  });

  test("keeps waiters pending until explicit cancellation settles and isolates owners", async () => {
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
    const abortObserved = deferred<void>();
    const drained = deferred<KanaSubagentRunResult>();
    const started = first.start({
      profile: profile(),
      task: "Wait for cancellation",
      spawnToolCallId: "call-spawn",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              abortObserved.resolve(undefined);
              void drained.promise.then(resolve);
            },
            { once: true },
          );
        }),
    });
    await Promise.resolve();

    expect(second.inspect(started.id)).toBeUndefined();
    await expect(second.wait(started.id)).resolves.toMatchObject({ status: "unknown" });

    let waitSettled = false;
    const waiting = first.wait(started.id, { waitMs: 100 });
    void waiting.then(() => {
      waitSettled = true;
    });
    const cancelling = first.cancel(started.id, {
      source: "tui",
      reason: "Stop from the TUI.",
    });
    await abortObserved.promise;
    await Promise.resolve();

    expect(waitSettled).toBe(false);
    expect(first.inspect(started.id)?.status).toBe("running");

    drained.resolve(result("cancelled after drain"));
    await expect(waiting).resolves.toMatchObject({
      status: "cancelled",
      waitTimedOut: false,
    });
    await expect(cancelling).resolves.toMatchObject({ status: "cancelled" });
  });

  test("publishes TUI cancellation until the completion is observed", async () => {
    const manager = new KanaSubagentManager();
    const client = manager.bind(
      manager.createOwner({ sessionId: "session-1", cwd: process.cwd(), persistent: false }),
      { maxLive: 1 },
    );
    const events: KanaSubagentEvent[] = [];
    client.subscribe((event) => events.push(event));
    const started = client.start({
      profile: profile(),
      task: "Cancel from the TUI",
      spawnToolCallId: "call-spawn",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(result("cancelled")), { once: true });
        }),
    });
    await Promise.resolve();

    await expect(
      client.cancel(started.id, { source: "tui", reason: "Stopped from /agents." }),
    ).resolves.toMatchObject({ status: "cancelled" });
    await Promise.resolve();

    expect(events.map((event) => event.type)).toEqual(["started", "settled"]);
    expect(client.context()).toMatchObject([{ id: started.id, status: "cancelled" }]);

    client.observe(started.id);
    expect(events.map((event) => event.type)).toEqual(["started", "settled", "observed"]);
    expect(client.context()).toEqual([]);
    await manager.close();
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
