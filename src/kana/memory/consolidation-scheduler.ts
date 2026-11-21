import { createNoopLogger, type Logger } from "@/logging";
import { formatError, SerialTaskQueue } from "@/utils";
import type { KanaConfig } from "../config";
import type { KanaCustomProviderSnapshot } from "../custom-provider";
import {
  type MemoryConsolidationResult,
  runIncrementalMemoryConsolidation,
} from "./consolidation-agent";
import {
  KANA_MEMORY_SCOPES,
  type KanaMemoryScope,
  type PendingKanaMemoryBatch,
  readPendingKanaMemoryBatch,
} from "./storage";

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
  schedule(
    scopes: Iterable<KanaMemoryScope>,
    options?: ScheduleMemoryConsolidationOptions,
  ): Promise<void>;
  recover(options?: ScheduleMemoryConsolidationOptions): Promise<void>;
  close(): Promise<void>;
};

type ScheduleMemoryConsolidationOptions = {
  // Keep the logger of the triggering session, even if the active session changes.
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
    batch: PendingKanaMemoryBatch,
    logger: Logger,
    signal: AbortSignal,
  ) => Promise<MemoryConsolidationResult>;
  logger?: Logger;
  customProviderSnapshot?: KanaCustomProviderSnapshot;
};

export function createMemoryConsolidationQueue(): MemoryConsolidationQueue {
  const queues: Record<KanaMemoryScope, SerialTaskQueue> = {
    global: new SerialTaskQueue(),
    project: new SerialTaskQueue(),
  };
  return { enqueue: (scope, operation) => queues[scope].run(operation) };
}

export function createMemoryConsolidationScheduler(
  config: KanaConfig,
  options: CreateMemoryConsolidationSchedulerOptions = {},
): MemoryConsolidationScheduler {
  const defaultLogger = options.logger ?? createNoopLogger();
  const queue = options.queue ?? createMemoryConsolidationQueue();
  const shutdown = new AbortController();
  const active = new Map<
    KanaMemoryScope,
    {
      promise: Promise<void>;
      request: (request: ScheduleMemoryConsolidationOptions) => void;
      logger: Logger;
    }
  >();
  const activities = new Set<MemoryConsolidationActivity>();
  const listeners = new Set<(event: MemoryConsolidationEvent) => void>();
  const publish = (event: MemoryConsolidationEvent): void => {
    for (const listener of listeners) listener(event);
  };
  let closePromise: Promise<void> | undefined;
  const runIncremental =
    options.runIncremental ??
    ((scope, batch, logger, signal) =>
      runIncrementalMemoryConsolidation(config, {
        scope,
        batch,
        cwd: options.cwd,
        env: options.env,
        customProviderSnapshot: options.customProviderSnapshot,
        logger,
        signal,
      }));

  function scheduleScope(
    scope: KanaMemoryScope,
    request: ScheduleMemoryConsolidationOptions,
    recovery: boolean,
  ): Promise<void> {
    const running = active.get(scope);
    if (running) {
      if (!recovery) running.request(request);
      return running.promise;
    }

    const logger = request.logger ?? defaultLogger;
    const activity: MemoryConsolidationActivity = { scope, status: "queued" };
    let nextRequest: ScheduleMemoryConsolidationOptions | undefined;
    const showQueued = () => {
      activities.add(activity);
      publish({ type: "activity_changed" });
    };
    const promise = queue.enqueue(scope, async () => {
      try {
        while (!shutdown.signal.aborted) {
          request = nextRequest ?? request;
          nextRequest = undefined;
          try {
            const batch = readPendingKanaMemoryBatch(scope, options);
            if (!batch) return;
            if (activity.status === "queued") {
              (request.logger ?? defaultLogger).info("memory_consolidation.scheduled", {
                scope,
                origin: recovery ? "startup" : "remember",
              });
              if (recovery) showQueued();
              activity.status = "organizing";
              publish({ type: "activity_changed" });
            }
            if (shutdown.signal.aborted) return;
            const result = await runIncremental(
              scope,
              batch,
              request.logger ?? defaultLogger,
              shutdown.signal,
            );
            request.onCompleted?.(scope, result);
            if (result.outcome === "updated" || result.outcome === "unchanged") continue;
            if (shutdown.signal.aborted) return;
            publish({
              type: "failed",
              scope,
              error: `Consolidation ended with ${result.outcome}.`,
            });
            if (!nextRequest) return;
          } catch (error) {
            if (shutdown.signal.aborted) return;
            publish({ type: "failed", scope, error: formatError(error) });
            // Only a new trigger that arrived while running can retry a failed batch here.
            if (!nextRequest) throw error;
            (request.logger ?? defaultLogger).warn("memory_consolidation.retry_requested", {
              scope,
              error,
            });
          }
        }
      } finally {
        active.delete(scope);
        if (activities.delete(activity)) publish({ type: "activity_changed" });
      }
    });
    active.set(scope, {
      promise,
      logger,
      request: (next) => {
        nextRequest = next;
      },
    });
    if (!recovery) showQueued();
    return promise;
  }

  function schedule(
    scopes: Iterable<KanaMemoryScope>,
    request: ScheduleMemoryConsolidationOptions,
    recovery: boolean,
  ): Promise<void> {
    if (shutdown.signal.aborted) return Promise.resolve();
    return Promise.all(
      [...new Set(scopes)].map((scope) => scheduleScope(scope, request, recovery)),
    ).then(() => undefined);
  }

  return {
    getActivity: () => [...activities].map((activity) => ({ ...activity })),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    schedule: (scopes, request = {}) => schedule(scopes, request, false),
    recover: (request = {}) => schedule(KANA_MEMORY_SCOPES, request, true),
    close() {
      if (closePromise) return closePromise;
      const jobs = [...active.values()];
      const pendingByLogger = new Map<Logger, number>();
      for (const { logger } of jobs) {
        pendingByLogger.set(logger, (pendingByLogger.get(logger) ?? 0) + 1);
      }
      for (const [logger, pendingScheduleCount] of pendingByLogger) {
        logger.info("memory_consolidation.shutdown_started", { pendingScheduleCount });
      }

      shutdown.abort(new Error("Memory consolidation scheduler is shutting down."));
      closePromise = Promise.allSettled(jobs.map(({ promise }) => promise)).then(() => {
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
