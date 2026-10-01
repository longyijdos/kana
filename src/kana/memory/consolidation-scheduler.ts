import type { Message } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaConfig } from "../config";
import type { KanaCustomProviderSnapshot } from "../custom-provider";
import {
  formatIncrementalMemoryConsolidationInput,
  type MemoryConsolidationResult,
  runMemoryConsolidation,
} from "./consolidation-agent";
import type { KanaMemoryEntry, KanaMemoryScope } from "./storage";

export type MemoryConsolidationActivity = {
  scope: KanaMemoryScope;
  status: "queued" | "organizing";
};

export type MemoryConsolidationEvent =
  | { type: "activity_changed" }
  | { type: "failed"; scope: KanaMemoryScope; error: string };

export type MemoryConsolidationActivitySource = {
  getActivity(): MemoryConsolidationActivity[];
  subscribe(listener: (event: MemoryConsolidationEvent) => void): () => void;
};

export type MemoryConsolidationScheduler = MemoryConsolidationActivitySource & {
  schedule(messages: Message[], options?: ScheduleMemoryConsolidationOptions): Promise<void>;
  close(): Promise<void>;
};

type ScheduleMemoryConsolidationOptions = {
  // A background run must retain the logger for the session that scheduled it.
  // The active TUI session can change before the queued work actually starts.
  logger?: Logger;
  onCompleted?: (scope: KanaMemoryScope, result: MemoryConsolidationResult) => void;
};

export type MemoryConsolidationQueue = {
  enqueue<T>(scope: KanaMemoryScope, operation: () => Promise<T>): Promise<T>;
};

export type CreateMemoryConsolidationSchedulerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  queue?: MemoryConsolidationQueue;
  runIncremental?: (
    scope: KanaMemoryScope,
    entries: KanaMemoryEntry[],
    logger: Logger,
    signal: AbortSignal,
  ) => Promise<MemoryConsolidationResult | undefined>;
  logger?: Logger;
  customProviderSnapshot?: KanaCustomProviderSnapshot;
};

export function createMemoryConsolidationQueue(): MemoryConsolidationQueue {
  const tails = new Map<KanaMemoryScope, Promise<void>>();

  return {
    enqueue(scope, operation) {
      const previous = tails.get(scope) ?? Promise.resolve();
      const result = previous.catch(() => undefined).then(operation);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );

      tails.set(scope, tail);
      void tail.finally(() => {
        if (tails.get(scope) === tail) {
          tails.delete(scope);
        }
      });

      return result;
    },
  };
}

export function createMemoryConsolidationScheduler(
  config: KanaConfig,
  options: CreateMemoryConsolidationSchedulerOptions = {},
): MemoryConsolidationScheduler {
  const defaultLogger = options.logger ?? createNoopLogger();
  const queue = options.queue ?? createMemoryConsolidationQueue();
  const shutdown = new AbortController();
  const activeSchedules = new Map<Promise<void>, Logger>();
  const activities = new Set<MemoryConsolidationActivity>();
  const listeners = new Set<(event: MemoryConsolidationEvent) => void>();
  const publish = (event: MemoryConsolidationEvent): void => {
    for (const listener of listeners) listener(event);
  };
  let closePromise: Promise<void> | undefined;
  const runIncremental =
    options.runIncremental ??
    (async (
      scope: KanaMemoryScope,
      entries: KanaMemoryEntry[],
      logger: Logger,
      signal: AbortSignal,
    ) => {
      return runMemoryConsolidation(config, {
        scope,
        mode: "incremental",
        cwd: options.cwd,
        env: options.env,
        customProviderSnapshot: options.customProviderSnapshot,
        input: formatIncrementalMemoryConsolidationInput(scope, entries, options),
        logger,
        signal,
      });
    });

  return {
    getActivity: () => [...activities].map((activity) => ({ ...activity })),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    schedule(messages, scheduleOptions = {}) {
      const entriesByScope = collectRememberedEntries(messages);
      if (entriesByScope.size === 0) {
        return Promise.resolve();
      }

      const logger = scheduleOptions.logger ?? defaultLogger;
      if (shutdown.signal.aborted) {
        logger.warn("memory_consolidation.schedule_skipped", {
          reason: "scheduler_closed",
          scopeCount: entriesByScope.size,
          entryCount: [...entriesByScope.values()].reduce(
            (count, entries) => count + entries.length,
            0,
          ),
        });
        return Promise.resolve();
      }

      logger.info("memory_consolidation.scheduled", {
        scopeCount: entriesByScope.size,
        entryCount: [...entriesByScope.values()].reduce(
          (count, entries) => count + entries.length,
          0,
        ),
      });
      const jobs = [...entriesByScope].map(([scope, entries]) => {
        const activity: MemoryConsolidationActivity = { scope, status: "queued" };
        activities.add(activity);
        publish({ type: "activity_changed" });
        return queue.enqueue(scope, async () => {
          activity.status = "organizing";
          publish({ type: "activity_changed" });
          try {
            let result: MemoryConsolidationResult | undefined;
            try {
              result = await runIncremental(scope, entries, logger, shutdown.signal);
            } catch (error) {
              if (!shutdown.signal.aborted) {
                publish({
                  type: "failed",
                  scope,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              throw error;
            }
            if (result) {
              if (
                result.outcome !== "updated" &&
                result.outcome !== "unchanged" &&
                !shutdown.signal.aborted
              ) {
                publish({
                  type: "failed",
                  scope,
                  error: `Consolidation ended with ${result.outcome}.`,
                });
              }
              scheduleOptions.onCompleted?.(scope, result);
            }
          } finally {
            activities.delete(activity);
            publish({ type: "activity_changed" });
          }
        });
      });
      const schedule = Promise.all(jobs).then(() => undefined);

      activeSchedules.set(schedule, logger);
      void schedule.then(
        () => activeSchedules.delete(schedule),
        () => activeSchedules.delete(schedule),
      );

      return schedule;
    },
    close() {
      if (closePromise) {
        return closePromise;
      }

      const pendingSchedules = [...activeSchedules];
      const pendingByLogger = new Map<Logger, number>();
      for (const [, logger] of pendingSchedules) {
        pendingByLogger.set(logger, (pendingByLogger.get(logger) ?? 0) + 1);
      }
      for (const [logger, pendingScheduleCount] of pendingByLogger) {
        logger.info("memory_consolidation.shutdown_started", { pendingScheduleCount });
      }

      // Automatic consolidation owns no durable state until its transaction
      // commits, so shutdown cancels model work while preserving daily entries.
      shutdown.abort(new Error("Memory consolidation scheduler is shutting down."));
      closePromise = Promise.allSettled(pendingSchedules.map(([schedule]) => schedule)).then(() => {
        for (const [logger, pendingScheduleCount] of pendingByLogger) {
          logger.info("memory_consolidation.shutdown_ended", {
            pendingScheduleCount,
            outcome: "settled",
          });
        }
      });

      return closePromise;
    },
  };
}

function collectRememberedEntries(messages: Message[]): Map<KanaMemoryScope, KanaMemoryEntry[]> {
  const entriesByScope = new Map<KanaMemoryScope, KanaMemoryEntry[]>();

  for (const message of messages) {
    if (
      message.role !== "tool" ||
      message.toolName !== "remember" ||
      message.isError ||
      !isKanaMemoryEntry(message.result)
    ) {
      continue;
    }

    const entries = entriesByScope.get(message.result.scope) ?? [];
    entries.push(message.result);
    entriesByScope.set(message.result.scope, entries);
  }

  return entriesByScope;
}

function isKanaMemoryEntry(value: unknown): value is KanaMemoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<KanaMemoryEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.createdAt === "string" &&
    (entry.scope === "global" || entry.scope === "project") &&
    typeof entry.content === "string"
  );
}
