import type { Message } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaConfig } from "../config";
import {
  formatIncrementalMemoryConsolidationInput,
  runMemoryConsolidation,
} from "./consolidation-agent";
import type { KanaMemoryEntry, KanaMemoryScope } from "./storage";

export type MemoryConsolidationScheduler = {
  schedule(messages: Message[], options?: ScheduleMemoryConsolidationOptions): Promise<void>;
};

export type ScheduleMemoryConsolidationOptions = {
  // A background run must retain the logger for the session that scheduled it.
  // The active TUI session can change before the queued work actually starts.
  logger?: Logger;
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
  ) => Promise<void>;
  logger?: Logger;
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
  const runIncremental =
    options.runIncremental ??
    (async (scope: KanaMemoryScope, entries: KanaMemoryEntry[], logger: Logger) => {
      await runMemoryConsolidation(config, {
        scope,
        mode: "incremental",
        cwd: options.cwd,
        env: options.env,
        input: formatIncrementalMemoryConsolidationInput(scope, entries, options),
        logger,
      });
    });

  return {
    schedule(messages, scheduleOptions = {}) {
      const entriesByScope = collectRememberedEntries(messages);
      if (entriesByScope.size === 0) {
        return Promise.resolve();
      }

      const logger = scheduleOptions.logger ?? defaultLogger;
      logger.info("memory_consolidation.scheduled", {
        scopeCount: entriesByScope.size,
        entryCount: [...entriesByScope.values()].reduce(
          (count, entries) => count + entries.length,
          0,
        ),
      });
      const jobs = [...entriesByScope].map(([scope, entries]) => {
        return queue.enqueue(scope, () => runIncremental(scope, entries, logger));
      });

      return Promise.all(jobs).then(() => undefined);
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
