import {
  createMessageIdentity,
  type ToolCallContent,
  type ToolResultMessage,
  type UserMessage,
} from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { ToolConcurrency } from "@/tools";
import { errorFields } from "@/utils";
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS, DEFAULT_TOOL_DEADLINE_MS } from "../settings";
import type { ToolResultPolicy } from "../tool-result-policy";
import { ToolInvoker } from "./invocation";
import { SerialEventQueue } from "./queues";
import {
  createCanceledToolResult,
  createUnknownToolResult,
  finalizeToolResult,
  isUnknownOutcome,
} from "./results";
import {
  type AgentEventSink,
  type ExecutedToolCall,
  findTool,
  type ToolRuntimeConfig,
} from "./types";

const DEFAULT_CANCELLATION_GRACE_MS = 1_000;
const RUN_ABORTED_MESSAGE = "Tool call canceled because the run was aborted.";
const SCHEDULER_FAILURE_MESSAGE =
  "Tool execution encountered an internal scheduler failure. Its outcome is unknown; do not retry automatically.";

export type ToolRuntimeResult = {
  toolResults: readonly ToolResultMessage[];
  additionalMessages: readonly UserMessage[];
  abortRun: boolean;
};

type GroupOutcome = {
  executed: ExecutedToolCall[];
  abortRun: boolean;
  failure?: { error: unknown };
  startedCount: number;
};

// Executes one assistant turn's tool calls. Adjacent parallel-safe calls share
// a worker pool; results are committed in model order whatever order they
// finish in.
export class ToolRuntime {
  private readonly events: SerialEventQueue;
  private readonly invoker: ToolInvoker;
  private readonly logger: Logger;
  private readonly maxParallelToolCalls: number;
  private readonly policies: readonly ToolResultPolicy[];

  constructor(
    private readonly config: ToolRuntimeConfig,
    emit: AgentEventSink,
  ) {
    this.events = new SerialEventQueue(emit);
    this.logger = config.logger ?? createNoopLogger();
    this.maxParallelToolCalls = config.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
    this.policies = config.toolResultPolicies ?? [];
    this.invoker = new ToolInvoker({
      config,
      events: this.events,
      logger: this.logger,
      cancellationGraceMs: config.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS,
      defaultDeadlineMs: config.defaultDeadlineMs ?? DEFAULT_TOOL_DEADLINE_MS,
      maxParallelToolCalls: this.maxParallelToolCalls,
    });
  }

  invoke(
    toolCall: ToolCallContent,
    options: {
      signal?: AbortSignal;
      onAbortRun?: () => void;
      parentToolCallId?: string;
      onExecutionEnd?: (durationMs: number) => void;
    } = {},
  ): Promise<ExecutedToolCall> {
    return this.invoker.invoke(toolCall, {
      ...options,
      groupSignal: options.signal ?? new AbortController().signal,
      tools: this.config.callableTools ?? this.config.tools,
    });
  }

  async execute(toolCalls: readonly ToolCallContent[]): Promise<ToolRuntimeResult> {
    const toolResults: ToolResultMessage[] = [];
    const additionalMessages: UserMessage[] = [];
    let abortRun = false;

    for (let index = 0; index < toolCalls.length; ) {
      if (abortRun || this.config.signal?.aborted) {
        abortRun = true;
        for (const toolCall of toolCalls.slice(index)) {
          const executed = canceled(toolCall, RUN_ABORTED_MESSAGE);
          await this.invoker.publishEnd(executed);
          await this.commit(executed, toolResults, additionalMessages);
        }
        break;
      }
      const group = this.readGroup(toolCalls, index);
      abortRun = await this.executeGroup(group, toolResults, additionalMessages);
      index += group.length;
    }

    // Keep every result for one assistant tool-call message contiguous. Some
    // providers reject user context interleaved between sibling tool results.
    for (const message of additionalMessages) {
      await this.config.onMessageCommitted?.(message);
    }
    if (additionalMessages.length > 0) {
      this.logger.info("tool.result_policy_context_committed", {
        policySource: this.policies.map((policy) => policy.source).join(","),
        messageCount: additionalMessages.length,
      });
    }

    return { toolResults, additionalMessages, abortRun };
  }

  // Only adjacent parallel calls share a group. Exclusive and unknown tools are
  // barriers, so read work never crosses a side-effecting call.
  private readGroup(toolCalls: readonly ToolCallContent[], start: number): ToolCallContent[] {
    let end = start + 1;
    if (
      this.config.parallelToolCalls !== false &&
      this.concurrencyOf(toolCalls[start]!) === "parallel"
    ) {
      while (end < toolCalls.length && this.concurrencyOf(toolCalls[end]!) === "parallel") {
        end += 1;
      }
    }
    return toolCalls.slice(start, end);
  }

  private concurrencyOf(toolCall: ToolCallContent): ToolConcurrency {
    return findTool(this.config.tools, toolCall.name)?.execution?.concurrency ?? "exclusive";
  }

  private async executeGroup(
    toolCalls: readonly ToolCallContent[],
    toolResults: ToolResultMessage[],
    additionalMessages: UserMessage[],
  ): Promise<boolean> {
    const pool = this.startPool(toolCalls);
    try {
      // A later call may finish and publish its live terminal event first, but
      // durable messages wait for model order. Sessions already journaled the
      // assistant call and recover any crash gap as an unknown outcome.
      for (const slot of pool.slots) {
        await this.commit(await slot, toolResults, additionalMessages);
      }
    } catch (error) {
      pool.fail(error);
      await pool.done;
      this.logPoolEnd(toolCalls.length, pool.outcome());
      throw error;
    }
    await pool.done;
    const outcome = pool.outcome();
    this.logPoolEnd(toolCalls.length, outcome);
    if (outcome.failure) {
      throw outcome.failure.error;
    }
    return outcome.abortRun;
  }

  private startPool(toolCalls: readonly ToolCallContent[]): {
    slots: Promise<ExecutedToolCall>[];
    done: Promise<void>;
    fail(error: unknown): void;
    outcome(): GroupOutcome;
  } {
    const groupController = new AbortController();
    const resolvers: Array<(executed: ExecutedToolCall) => void> = [];
    const slots = toolCalls.map(
      () => new Promise<ExecutedToolCall>((resolve) => resolvers.push(resolve)),
    );
    const executed: Array<ExecutedToolCall | undefined> = toolCalls.map(() => undefined);
    // Workers share these on one event loop. Claiming an index is synchronous,
    // so calls enter validation and approval in model order.
    let nextIndex = 0;
    let abortRun = false;
    let failure: { error: unknown } | undefined;
    const stop = (): void => {
      if (!groupController.signal.aborted) groupController.abort();
    };
    const stopForAbort = (): void => {
      abortRun = true;
      stop();
    };
    const fail = (error: unknown): void => {
      failure ??= { error };
      stop();
    };
    const settle = async (index: number, result: ExecutedToolCall): Promise<void> => {
      executed[index] = result;
      try {
        // Live completion follows physical settlement; the ordered slot is
        // resolved afterwards so commit order never delays a later call's event.
        await this.invoker.publishEnd(result);
      } catch (error) {
        fail(error);
      }
      resolvers[index]?.(result);
    };

    const runWorker = async (): Promise<void> => {
      while (true) {
        if (this.config.signal?.aborted) stopForAbort();
        if (groupController.signal.aborted || nextIndex >= toolCalls.length) return;
        const index = nextIndex++;
        const toolCall = toolCalls[index]!;
        let result: ExecutedToolCall;
        try {
          result = await this.invoker.execute(toolCall, {
            groupSignal: groupController.signal,
            onAbortRun: stopForAbort,
          });
        } catch (error) {
          fail(error);
          result = unknownOutcome(toolCall);
          result.abortRun = true;
        }
        if (result.abortRun) stopForAbort();
        await settle(index, result);
      }
    };

    const workerCount = Math.min(toolCalls.length, this.maxParallelToolCalls);
    if (toolCalls.length > 1) {
      this.logger.debug("tool.parallel_pool_started", {
        toolCount: toolCalls.length,
        maxParallelToolCalls: this.maxParallelToolCalls,
        workerCount,
      });
    }
    const workers = Array.from({ length: workerCount }, () => runWorker().catch(fail));
    const done = Promise.all(workers).then(async () => {
      // Calls never claimed were canceled; claimed calls without a result
      // escaped the guarded path and have an unknown outcome.
      for (const [index, toolCall] of toolCalls.entries()) {
        if (executed[index]) continue;
        await settle(
          index,
          index < nextIndex
            ? unknownOutcome(toolCall)
            : canceled(
                toolCall,
                failure === undefined
                  ? RUN_ABORTED_MESSAGE
                  : "Tool call canceled before execution because parallel scheduling failed.",
              ),
        );
      }
    });

    return {
      slots,
      done,
      fail,
      outcome: () => ({
        executed: executed.filter((result) => result !== undefined),
        abortRun,
        failure,
        startedCount: nextIndex,
      }),
    };
  }

  private logPoolEnd(toolCount: number, outcome: GroupOutcome): void {
    if (toolCount <= 1) {
      return;
    }
    const unknownOutcomeCount = outcome.executed.filter(isUnknownOutcome).length;
    const result = outcome.failure ? "failed" : outcome.abortRun ? "aborted" : "completed";
    const metadata = {
      toolCount,
      maxParallelToolCalls: this.maxParallelToolCalls,
      startedCount: outcome.startedCount,
      canceledBeforeStartCount: toolCount - outcome.startedCount,
      unknownOutcomeCount,
      outcome: result,
      ...(outcome.failure ? errorFields(outcome.failure.error) : {}),
    };
    if (result !== "completed") {
      const level = outcome.failure || unknownOutcomeCount > 0 ? "warn" : "info";
      this.logger[level]("tool.parallel_pool_abnormal_drain", metadata);
    }
    this.logger.debug("tool.parallel_pool_ended", metadata);
  }

  private async commit(
    executed: ExecutedToolCall,
    toolResults: ToolResultMessage[],
    additionalMessages: UserMessage[],
  ): Promise<void> {
    const finalized = await finalizeToolResult(executed, this.policies, {
      contentByteLimit: this.config.toolContentByteLimit,
      logger: this.logger,
    });
    const message: ToolResultMessage = {
      ...createMessageIdentity({ kind: "tool_result" }),
      role: "tool",
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
      content: this.config.limitToolContent?.(finalized.content) ?? finalized.content,
      durationMs: executed.durationMs,
      ...(executed.result.images?.length ? { images: executed.result.images } : {}),
      ...(finalized.artifact === undefined ? {} : { artifact: finalized.artifact }),
      ...(finalized.persistResult ? { result: finalized.result } : {}),
      isError: executed.isError,
    };
    await this.config.onMessageCommitted?.(message);
    toolResults.push(message);
    additionalMessages.push(...finalized.additionalMessages);
  }
}

function canceled(toolCall: ToolCallContent, message: string): ExecutedToolCall {
  return { toolCall, result: createCanceledToolResult(message), isError: true, durationMs: 0 };
}

function unknownOutcome(toolCall: ToolCallContent): ExecutedToolCall {
  return {
    toolCall,
    result: createUnknownToolResult(SCHEDULER_FAILURE_MESSAGE, "internal_scheduler_failure"),
    isError: true,
    durationMs: 0,
  };
}
