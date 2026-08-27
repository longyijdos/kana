import type { AgentEndReason, ContextCompactionReason } from "@/agent";
import type { ModelUsage } from "@/core";
import type { KanaGoalSnapshot } from "@/kana";

const KANA_EXEC_EVENT_SCHEMA_VERSION = 2 as const;

export type KanaExecUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_miss_input_tokens?: number;
  reasoning_tokens?: number;
};

type KanaExecEventBase = {
  schema_version: typeof KANA_EXEC_EVENT_SCHEMA_VERSION;
};

export type KanaExecRunTermination =
  | {
      reason: "timeout";
      timeout_ms: number;
    }
  | {
      reason: "sigint";
    };

export type KanaExecGoalResult = {
  status: Exclude<KanaGoalSnapshot["status"], "active">;
  admitted_rounds: number;
  max_rounds: number;
  detail?: string;
};

export type KanaExecEvent =
  | (KanaExecEventBase & {
      type: "session.started";
      session_id: string;
    })
  | (KanaExecEventBase & {
      type: "warning";
      phase: "mcp_startup";
      message: string;
      server_id?: string;
    })
  | (KanaExecEventBase & {
      type: "run.started";
    })
  | (KanaExecEventBase & {
      type: "model_turn.started";
      turn: number;
    })
  | (KanaExecEventBase & {
      type: "model_turn.completed";
      turn: number;
      stop_reason?: string;
      usage?: KanaExecUsage;
    })
  | (KanaExecEventBase & {
      type: "assistant.delta";
      delta: string;
    })
  | (KanaExecEventBase & {
      type: "assistant.completed";
      text: string;
      usage?: KanaExecUsage;
    })
  | (KanaExecEventBase & {
      type: "tool.started";
      tool_call_id: string;
      name: string;
      arguments: unknown;
    })
  | (KanaExecEventBase & {
      type: "tool.updated";
      tool_call_id: string;
      name: string;
      partial_result: unknown;
    })
  | (KanaExecEventBase & {
      type: "tool.completed";
      tool_call_id: string;
      name: string;
      result: unknown;
      is_error: boolean;
    })
  | (KanaExecEventBase & {
      type: "context.compaction_started";
      reason: ContextCompactionReason;
      estimated_tokens: number;
      context_limit: number;
    })
  | (KanaExecEventBase & {
      type: "context.compacted";
      reason: ContextCompactionReason;
      before_tokens: number;
      estimated_after_tokens: number;
      compacted_message_count: number;
      context_limit: number;
      usage?: KanaExecUsage;
    })
  | (KanaExecEventBase & {
      type: "run.completed";
      outcome: AgentEndReason;
      usage?: KanaExecUsage;
      termination?: KanaExecRunTermination;
      goal?: KanaExecGoalResult;
    })
  | (KanaExecEventBase & {
      type: "run.failed";
      error: {
        name: string;
        message: string;
      };
      termination?: KanaExecRunTermination;
      goal?: KanaExecGoalResult;
    })
  | (KanaExecEventBase & {
      type: "error";
      phase: "startup";
      error: {
        name: string;
        message: string;
      };
    });

export function createKanaExecEvent<TEvent extends Omit<KanaExecEvent, "schema_version">>(
  event: TEvent,
): TEvent & KanaExecEventBase {
  return {
    schema_version: KANA_EXEC_EVENT_SCHEMA_VERSION,
    ...event,
  };
}

export function toKanaExecUsage(usage: ModelUsage | undefined): KanaExecUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    ...(usage.promptCacheHitTokens === undefined
      ? {}
      : { cache_read_input_tokens: usage.promptCacheHitTokens }),
    ...(usage.promptCacheMissTokens === undefined
      ? {}
      : { cache_miss_input_tokens: usage.promptCacheMissTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
  };
}

export function toKanaExecGoal(goal: KanaGoalSnapshot): KanaExecGoalResult {
  if (goal.status === "active") {
    throw new Error("Cannot project an active Goal as a completed headless run.");
  }
  return {
    status: goal.status,
    admitted_rounds: goal.admittedRounds,
    max_rounds: goal.maxRounds,
    ...(goal.detail === undefined ? {} : { detail: goal.detail }),
  };
}

export function toKanaExecRunTermination(
  termination: { reason: "timeout"; timeoutMs: number } | { reason: "sigint" },
): KanaExecRunTermination {
  return termination.reason === "timeout"
    ? { reason: "timeout", timeout_ms: termination.timeoutMs }
    : { reason: "sigint" };
}
