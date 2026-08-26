import { Agent, type AgentEndReason, type AgentState, createModelCompactPolicy } from "@/agent";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaConfig } from "../config";
import { createKanaAgentModelRuntime } from "../model";
import { buildMemoryConsolidationPrompt } from "./consolidation-prompt";
import {
  createMemoryConsolidationTools,
  createMemoryConsolidationTransaction,
  type MemoryConsolidationMode,
  type MemoryConsolidationTransaction,
} from "./consolidation-tools";
import {
  type KanaMemoryEntry,
  type KanaMemoryScope,
  loadKanaMemory,
  pruneKanaDailyMemory,
} from "./storage";

export type CreateMemoryConsolidationAgentOptions = {
  scope: KanaMemoryScope;
  mode: MemoryConsolidationMode;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  logger?: Logger;
};

type MemoryConsolidationOutcome = "updated" | "unchanged" | "aborted" | "length" | "turn_limit";

export type MemoryConsolidationResult = {
  state: AgentState;
  outcome: MemoryConsolidationOutcome;
};

export function createMemoryConsolidationAgent(
  config: KanaConfig,
  options: CreateMemoryConsolidationAgentOptions,
  memory: MemoryConsolidationTransaction = createMemoryConsolidationTransaction(options),
): Agent {
  if (!config.memory.enabled) {
    throw new Error("Memory is disabled.");
  }
  const runtime = createKanaAgentModelRuntime(config.memory.agent, config.provider, {
    env: options.env,
    logger: options.logger,
  });

  return new Agent({
    model: runtime.model,
    system: buildMemoryConsolidationPrompt(
      options.scope,
      options.mode,
      config.memory.dailyRetentionDays,
    ),
    tools: createMemoryConsolidationTools(options, options.mode, memory),
    maxTurns: config.memory.agent.maxTurns,
    toolDeadlineMs: config.memory.agent.toolDeadlineMs,
    webSearch: runtime.webSearch,
    imageInput: runtime.imageInput,
    parallelToolCalls: runtime.parallelToolCalls,
    maxParallelToolCalls: config.memory.agent.maxParallelToolCalls,
    logger: options.logger,
    loggerMetadata: {
      agentKind: "memory_consolidation",
      memoryScope: options.scope,
      memoryMode: options.mode,
    },
    context: {
      contextLimit: runtime.contextLimit,
      maxOutputTokens: runtime.maxOutputTokens,
      compactPolicy: createModelCompactPolicy(runtime.model, {
        imageInputEnabled: runtime.imageInput,
      }),
    },
  });
}

export function formatIncrementalMemoryConsolidationInput(
  scope: KanaMemoryScope,
  entries: KanaMemoryEntry[],
  options: Pick<CreateMemoryConsolidationAgentOptions, "cwd" | "env"> = {},
): string {
  return [
    "<current_memory>",
    loadKanaMemory(scope, options).trim(),
    "</current_memory>",
    "<new_daily_entries>",
    JSON.stringify(entries),
    "</new_daily_entries>",
  ].join("\n");
}

export function formatFullMemoryConsolidationInput(userRequest?: string): string {
  const request = userRequest?.trim();

  return [
    "<compaction_request>",
    "Review the current memory and available daily entries. Update memory only when it improves future reference.",
    "</compaction_request>",
    request ? `<user_request>\n${request}\n</user_request>` : undefined,
  ]
    .filter((block): block is string => block !== undefined)
    .join("\n");
}

export type RunMemoryConsolidationOptions = CreateMemoryConsolidationAgentOptions & {
  input: string;
  signal?: AbortSignal;
};

export type RunFullMemoryConsolidationOptions = Omit<
  CreateMemoryConsolidationAgentOptions,
  "mode"
> & {
  userRequest?: string;
  signal?: AbortSignal;
};

export async function runMemoryConsolidation(
  config: KanaConfig,
  options: RunMemoryConsolidationOptions,
): Promise<MemoryConsolidationResult> {
  const logger = options.logger ?? createNoopLogger();
  logger.info("memory_consolidation.started", { scope: options.scope, mode: options.mode });
  const memory = createMemoryConsolidationTransaction(options);
  const agent = createMemoryConsolidationAgent(config, options, memory);
  const abort = () => agent.abort();

  if (options.signal?.aborted) {
    logger.info("memory_consolidation.ended", {
      scope: options.scope,
      mode: options.mode,
      outcome: "aborted",
    });
    return { state: agent.state, outcome: "aborted" };
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }

  let endReason: AgentEndReason | undefined;
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "agent_end") {
      endReason = event.reason;
    }
  });

  try {
    await agent.prompt(options.input);
  } finally {
    unsubscribe();
    options.signal?.removeEventListener("abort", abort);
  }

  if (endReason === undefined) {
    throw new Error("Memory consolidation finished without an agent_end event.");
  }

  if (endReason === "stop" && memory.hasChanges) {
    memory.commit();
  }

  if (endReason === "stop" && options.mode === "full") {
    const retentionDays = config.memory.dailyRetentionDays;
    if (retentionDays !== undefined) {
      pruneKanaDailyMemory(options.scope, {
        cwd: options.cwd,
        env: options.env,
        now: options.now,
        retentionDays,
      });
    }
  }

  const outcome =
    endReason === "stop"
      ? memory.hasChanges
        ? "updated"
        : "unchanged"
      : endReason === "length"
        ? "length"
        : endReason === "turn_limit"
          ? "turn_limit"
          : "aborted";
  logger.info("memory_consolidation.ended", { scope: options.scope, mode: options.mode, outcome });

  return {
    state: agent.state,
    outcome,
  };
}

export function runFullMemoryConsolidation(
  config: KanaConfig,
  options: RunFullMemoryConsolidationOptions,
): Promise<MemoryConsolidationResult> {
  return runMemoryConsolidation(config, {
    ...options,
    mode: "full",
    input: formatFullMemoryConsolidationInput(options.userRequest),
  });
}
