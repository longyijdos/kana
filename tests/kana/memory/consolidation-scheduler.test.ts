import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_KANA_CONFIG } from "@/kana";
import { createLogger } from "@/logging";
import { Agent } from "../../../src/agent";
import {
  appendKanaMemory,
  createMemoryConsolidationQueue,
  createMemoryConsolidationScheduler,
  createMemoryConsolidationTransaction,
  type KanaMemoryScope,
  type MemoryConsolidationEvent,
  type PendingKanaMemoryBatch,
  readPendingKanaMemoryBatch,
} from "../../../src/kana/memory";
import type { MemoryConsolidationResult } from "../../../src/kana/memory/consolidation-agent";
import { MockModel } from "../../../src/providers/mock";
import { deferred, waitFor } from "../../helpers/async-control";
import {
  cleanupTempKanaHomes,
  createTempKanaHomeEnv as createTempEnv,
} from "../../helpers/temp-kana-home";

afterEach(cleanupTempKanaHomes);

describe("memory consolidation scheduler", () => {
  test("does not start an Agent or show activity on an empty startup", async () => {
    const events: string[] = [];
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      env: createTempEnv(),
      logger: createLogger((_level, event) => events.push(event)),
      runIncremental: async () => {
        throw new Error("Nothing to organize");
      },
    });
    scheduler.subscribe((event) => events.push(event.type));
    await scheduler.schedule([]);
    await scheduler.recover();
    expect(events).toEqual([]);
  });

  test("replays a failed batch before newer entries across day rollover", async () => {
    const env = createTempEnv();
    const calls: string[][] = [];
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      env,
      runIncremental: async (scope, batch) => {
        calls.push(ids(batch));
        if (calls.length === 1) throw new Error("Provider 429");
        return commit(scope, batch, env);
      },
    });
    append(env, "A", 20);
    await expect(scheduler.schedule(["project"])).rejects.toThrow("Provider 429");
    expect(calls).toEqual([["A"]]);
    expect(ids(readPendingKanaMemoryBatch("project", { env })!)).toEqual(["A"]);

    append(env, "B", 21);
    await scheduler.schedule(["project"]);
    append(env, "C", 21);
    await scheduler.schedule(["project"]);
    expect(calls).toEqual([["A"], ["A", "B"], ["C"]]);
    expect(readPendingKanaMemoryBatch("project", { env })).toBeUndefined();
  });

  test("coalesces queued triggers and drains entries appended during a run", async () => {
    const env = createTempEnv();
    const calls: string[][] = [];
    const firstRun = deferred();
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      env,
      runIncremental: async (scope, batch) => {
        calls.push(ids(batch));
        if (calls.length === 1) await firstRun.promise;
        return commit(scope, batch, env);
      },
    });
    append(env, "A");
    const first = scheduler.schedule(["project"]);
    append(env, "B");
    const second = scheduler.schedule(["project"]);
    expect(scheduler.getActivity()).toEqual([{ scope: "project", status: "queued" }]);
    await waitFor(() => calls.length === 1);
    expect(calls).toEqual([["A", "B"]]);

    append(env, "C");
    const third = scheduler.schedule(["project", "project"]);
    expect(scheduler.getActivity()).toEqual([{ scope: "project", status: "organizing" }]);
    firstRun.resolve();
    await Promise.all([first, second, third]);
    expect(calls).toEqual([["A", "B"], ["C"]]);
    expect(scheduler.getActivity()).toEqual([]);
  });

  test("keeps a new trigger received during a batch that subsequently fails", async () => {
    const env = createTempEnv();
    const firstRun = deferred();
    const calls: string[][] = [];
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      env,
      runIncremental: async (scope, batch) => {
        calls.push(ids(batch));
        if (calls.length === 1) {
          await firstRun.promise;
          throw new Error("Provider 502");
        }
        return commit(scope, batch, env);
      },
    });
    append(env, "A");
    const first = scheduler.schedule(["project"]);
    await waitFor(() => calls.length === 1);
    append(env, "B");
    const second = scheduler.schedule(["project"]);
    firstRun.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual([["A"], ["A", "B"]]);
  });

  test.each(["length", "turn_limit", "aborted"] as const)(
    "recovers only the uncommitted suffix on restart after %s",
    async (outcome) => {
      const env = createTempEnv();
      const remembered = Array.from({ length: 36 }, (_, i) => `entry-${i}`);
      for (const id of remembered) append(env, id);
      const failedRuns: string[][] = [];
      const beforeRestart = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
        env,
        runIncremental: async (scope, batch) => {
          failedRuns.push(ids(batch));
          return failedRuns.length === 1 ? commit(scope, batch, env) : consolidationResult(outcome);
        },
      });
      const events: MemoryConsolidationEvent[] = [];
      beforeRestart.subscribe((event) => events.push(event));
      await beforeRestart.schedule(["project"]);
      await beforeRestart.close();
      expect(failedRuns).toEqual([remembered.slice(0, 32), remembered.slice(32)]);
      expect(events).toContainEqual({
        type: "failed",
        scope: "project",
        error: `Consolidation ended with ${outcome}.`,
      });

      const recovered: string[][] = [];
      const afterRestart = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
        env,
        runIncremental: async (scope, batch) => {
          recovered.push(ids(batch));
          return commit(scope, batch, env);
        },
      });
      await afterRestart.recover();
      await afterRestart.recover();
      expect(recovered).toEqual([remembered.slice(32)]);
      expect(readPendingKanaMemoryBatch("project", { env })).toBeUndefined();
    },
  );

  test("shares a queue with Full Compact, and reads pending work only when admitted", async () => {
    const env = createTempEnv();
    const queue = createMemoryConsolidationQueue();
    const fullRun = deferred();
    const started: string[] = [];
    const full = queue.enqueue("project", async () => {
      started.push("full");
      await fullRun.promise;
    });
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      env,
      queue,
      runIncremental: async (scope, batch) => {
        started.push(`${scope}: ${ids(batch).join(", ")}`);
        return commit(scope, batch, env);
      },
    });
    append(env, "A");
    append(env, "global", 20, "global");
    const incremental = scheduler.schedule(["project", "global"]);
    await waitFor(() => started.length === 2);
    expect(started).toEqual(["full", "global: global"]);
    append(env, "B");
    fullRun.resolve();
    await Promise.all([incremental, full]);
    expect(started).toEqual(["full", "global: global", "project: A, B"]);
  });

  test("keeps the scheduling logger and waits for every active scope on shutdown", async () => {
    const env = createTempEnv();
    const active = deferred();
    const finishGlobal = deferred();
    const logs: string[] = [];
    const logger = createLogger((_level, event) => logs.push(event));
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      env,
      runIncremental: async (scope, _batch, runLogger, signal) => {
        expect(runLogger).toBe(logger);
        if (scope === "project") throw new Error("Provider unavailable");
        active.resolve();
        await finishGlobal.promise;
        expect(signal.aborted).toBe(true);
        return consolidationResult("aborted");
      },
    });
    append(env, "project");
    append(env, "global", 20, "global");
    const started = scheduler.schedule(["global", "project"], { logger });
    await expect(started).rejects.toThrow("Provider unavailable");
    await active.promise;
    let closed = false;
    const shutdown = scheduler.close();
    void shutdown.then(() => {
      closed = true;
    });
    expect(scheduler.close()).toBe(shutdown);
    await Promise.resolve();
    expect(closed).toBe(false);
    finishGlobal.resolve();
    await shutdown;
    expect(scheduler.getActivity()).toEqual([]);
    expect(ids(readPendingKanaMemoryBatch("global", { env })!)).toEqual(["global"]);
    expect(logs).toEqual([
      "memory_consolidation.scheduled",
      "memory_consolidation.scheduled",
      "memory_consolidation.shutdown_started",
      "memory_consolidation.shutdown_ended",
    ]);
  });
});

function consolidationResult(
  outcome: MemoryConsolidationResult["outcome"],
): MemoryConsolidationResult {
  return {
    outcome,
    state: new Agent({ model: new MockModel({ provider: "mock", model: "mock" }) }).state,
  };
}

function append(env: NodeJS.ProcessEnv, id: string, day = 20, scope: KanaMemoryScope = "project") {
  return appendKanaMemory({
    env,
    id,
    scope,
    content: `Content for ${id}`,
    now: new Date(2026, 5, day),
  });
}

function ids(batch: PendingKanaMemoryBatch): string[] {
  return batch.entries.map((entry) => entry.id);
}

function commit(scope: KanaMemoryScope, batch: PendingKanaMemoryBatch, env: NodeJS.ProcessEnv) {
  createMemoryConsolidationTransaction({ scope, env }).commit(batch.checkpoint);
  return consolidationResult("unchanged");
}
