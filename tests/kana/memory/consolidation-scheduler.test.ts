import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@/core";
import { DEFAULT_KANA_CONFIG } from "@/kana";
import type { Logger } from "@/logging";
import { Agent } from "../../../src/agent";
import {
  createMemoryConsolidationQueue,
  createMemoryConsolidationScheduler,
  type MemoryConsolidationEvent,
} from "../../../src/kana/memory";
import type { MemoryConsolidationResult } from "../../../src/kana/memory/consolidation-agent";
import { MockModel } from "../../../src/providers/mock";
import { deferred, waitFor } from "../../helpers/async-control";
import { messageIdentityForTest } from "../../helpers/messages";

describe("memory consolidation scheduler", () => {
  test("does not log or schedule when no successful remember entries exist", async () => {
    const events: string[] = [];
    const logger: Logger = {
      debug: (event) => events.push(event),
      info: (event) => events.push(event),
      warn: (event) => events.push(event),
      error: (event) => events.push(event),
    };
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, { logger });

    await scheduler.schedule([
      {
        ...messageIdentityForTest("tool"),
        role: "tool",
        toolCallId: "call_read",
        toolName: "read",
        content: "",
        isError: false,
      },
    ]);

    expect(events).toEqual([]);
  });

  test("groups successful remember entries by scope", async () => {
    const calls: Array<{ scope: string; entries: string[] }> = [];
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      runIncremental: async (scope, entries) => {
        calls.push({ scope, entries: entries.map((entry) => entry.id) });
      },
    });

    await scheduler.schedule([
      rememberResult("project", "mem_project_1"),
      rememberResult("project", "mem_project_2"),
      rememberResult("global", "mem_global"),
      { ...rememberResult("project", "mem_failed"), isError: true },
      {
        ...messageIdentityForTest("tool"),
        role: "tool",
        toolCallId: "call_read",
        toolName: "read",
        content: "",
        isError: false,
      },
    ]);

    expect(calls).toEqual([
      { scope: "project", entries: ["mem_project_1", "mem_project_2"] },
      { scope: "global", entries: ["mem_global"] },
    ]);
  });

  test("serializes runs for the same scope", async () => {
    const started: string[] = [];
    const secondRun = deferred();
    let releaseFirst!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      runIncremental: async (_scope, entries) => {
        started.push(entries[0].id);
        if (entries[0].id === "mem_first") {
          await firstRun;
        } else {
          await secondRun.promise;
        }
      },
    });

    const first = scheduler.schedule([rememberResult("project", "mem_first")]);
    const second = scheduler.schedule([rememberResult("project", "mem_second")]);

    expect(scheduler.getActivity()).toEqual([
      { scope: "project", status: "queued" },
      { scope: "project", status: "queued" },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["mem_first"]);
    expect(scheduler.getActivity()).toEqual([
      { scope: "project", status: "organizing" },
      { scope: "project", status: "queued" },
    ]);

    releaseFirst();
    await waitFor(() => started.length === 2);
    expect(scheduler.getActivity()).toEqual([{ scope: "project", status: "organizing" }]);
    secondRun.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["mem_first", "mem_second"]);
    expect(scheduler.getActivity()).toEqual([]);
  });

  test("reports a failed scope while independent work remains active", async () => {
    const globalRun = deferred();
    const events: MemoryConsolidationEvent[] = [];
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      runIncremental: async (scope) => {
        if (scope === "project") throw new Error("Provider unavailable");
        await globalRun.promise;
      },
    });
    const unsubscribe = scheduler.subscribe((event) => events.push(event));

    await expect(
      scheduler.schedule([
        rememberResult("project", "mem_project"),
        rememberResult("global", "mem_global"),
      ]),
    ).rejects.toThrow("Provider unavailable");

    expect(events.filter((event) => event.type === "failed")).toEqual([
      { type: "failed", scope: "project", error: "Provider unavailable" },
    ]);
    expect(scheduler.getActivity()).toEqual([{ scope: "global", status: "organizing" }]);

    unsubscribe();
    const eventCount = events.length;
    globalRun.resolve();
    await waitFor(() => scheduler.getActivity().length === 0);
    expect(events).toHaveLength(eventCount);
  });

  test("reports unfinished outcomes without treating normal completion as failure", async () => {
    const failures: MemoryConsolidationEvent[] = [];
    for (const outcome of ["updated", "unchanged", "length", "turn_limit", "aborted"] as const) {
      const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
        runIncremental: async () => consolidationResult(outcome),
      });
      scheduler.subscribe((event) => {
        if (event.type === "failed") failures.push(event);
      });
      await scheduler.schedule([rememberResult("project", `mem_${outcome}`)]);
      expect(scheduler.getActivity()).toEqual([]);
    }

    expect(failures).toEqual(
      ["length", "turn_limit", "aborted"].map((outcome) => ({
        type: "failed",
        scope: "project",
        error: `Consolidation ended with ${outcome}.`,
      })),
    );
  });

  test("retains the logger supplied when work is scheduled", async () => {
    const scheduledEvents: string[] = [];
    const runEvents: string[] = [];
    const scheduledLogger = createLogger(scheduledEvents);
    const laterLogger = createLogger([]);
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      logger: laterLogger,
      runIncremental: async (_scope, _entries, logger) => {
        logger.info("memory_consolidation.run");
        runEvents.push(logger === scheduledLogger ? "scheduled" : "other");
      },
    });

    await scheduler.schedule([rememberResult("project", "mem_project")], {
      logger: scheduledLogger,
    });

    expect(scheduledEvents).toEqual(["memory_consolidation.scheduled", "memory_consolidation.run"]);
    expect(runEvents).toEqual(["scheduled"]);
  });

  test("shares a queue between incremental and full consolidation work", async () => {
    const queue = createMemoryConsolidationQueue();
    const started: string[] = [];
    let releaseIncremental!: () => void;
    const incrementalBlocked = new Promise<void>((resolve) => {
      releaseIncremental = resolve;
    });
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      queue,
      runIncremental: async () => {
        started.push("incremental");
        await incrementalBlocked;
      },
    });

    const incremental = scheduler.schedule([rememberResult("project", "mem_project")]);
    const full = queue.enqueue("project", async () => {
      started.push("full");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["incremental"]);

    releaseIncremental();
    await Promise.all([incremental, full]);
    expect(started).toEqual(["incremental", "full"]);
  });

  test("aborts and awaits active schedules during shutdown", async () => {
    const events: string[] = [];
    const activityEvents: MemoryConsolidationEvent[] = [];
    const logger = createLogger(events);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let runSignal: AbortSignal | undefined;
    let runSettled = false;
    const scheduler = createMemoryConsolidationScheduler(DEFAULT_KANA_CONFIG, {
      logger,
      runIncremental: async (_scope, _entries, _logger, signal) => {
        runSignal = signal;
        markStarted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        runSettled = true;
        return consolidationResult("aborted");
      },
    });
    scheduler.subscribe((event) => activityEvents.push(event));

    const scheduled = scheduler.schedule([rememberResult("project", "mem_project")]);
    await started;

    const shutdown = scheduler.close();
    expect(scheduler.close()).toBe(shutdown);
    await Promise.all([scheduled, shutdown]);

    expect(runSignal?.aborted).toBe(true);
    expect(runSettled).toBe(true);
    expect(scheduler.getActivity()).toEqual([]);
    expect(activityEvents.some((event) => event.type === "failed")).toBe(false);
    expect(events).toEqual([
      "memory_consolidation.scheduled",
      "memory_consolidation.shutdown_started",
      "memory_consolidation.shutdown_ended",
    ]);

    await scheduler.schedule([rememberResult("project", "mem_after_shutdown")]);
    expect(events.at(-1)).toBe("memory_consolidation.schedule_skipped");
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

function createLogger(events: string[]): Logger {
  return {
    debug: (event) => events.push(event),
    info: (event) => events.push(event),
    warn: (event) => events.push(event),
    error: (event) => events.push(event),
  };
}

function rememberResult(scope: "global" | "project", id: string): ToolResultMessage {
  return {
    ...messageIdentityForTest("tool"),
    role: "tool",
    toolCallId: `call_${id}`,
    toolName: "remember",
    content: `Memory recorded in ${scope} scope.`,
    result: {
      id,
      createdAt: "2026-06-20T00:00:00.000Z",
      scope,
      content: `Content for ${id}`,
    },
    isError: false,
  };
}
