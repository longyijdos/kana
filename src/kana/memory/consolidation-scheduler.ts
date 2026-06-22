import type { Message } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaConfig } from "../config";
import {
  formatIncrementalMemoryConsolidationInput,
  runMemoryConsolidation,
} from "./consolidation-agent";
import type { KanaMemoryEntry, KanaMemoryScope } from "./storage";

export type MemoryConsolidationScheduler = {
  schedule(messages: Message[]): Promise<void>;
};

export type CreateMemoryConsolidationSchedulerOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runIncremental?: (scope: KanaMemoryScope, entries: KanaMemoryEntry[]) => Promise<void>;
  logger?: Logger;
};

export function createMemoryConsolidationScheduler(
  config: KanaConfig,
  options: CreateMemoryConsolidationSchedulerOptions = {},
): MemoryConsolidationScheduler {
  const logger = options.logger ?? createNoopLogger();
  const queuedRuns = new Map<KanaMemoryScope, Promise<void>>();
  const runIncremental =
    options.runIncremental ??
    (async (scope: KanaMemoryScope, entries: KanaMemoryEntry[]) => {
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
    schedule(messages) {
      const entriesByScope = collectRememberedEntries(messages);
      if (entriesByScope.size === 0) {
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
        const previousRun = queuedRuns.get(scope) ?? Promise.resolve();
        const run = previousRun.catch(() => undefined).then(() => runIncremental(scope, entries));

        queuedRuns.set(scope, run);
        return run;
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
