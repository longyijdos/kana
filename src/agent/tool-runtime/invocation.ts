import type { ToolCallContent } from "@/core";
import type { Logger } from "@/logging";
import { normalizeToolResult, type Tool, validateToolArguments } from "@/tools";
import { errorFields, formatError, SerialTaskQueue } from "@/utils";
import { createNestedToolInvoker } from "./nested";
import type { SerialEventQueue } from "./queues";
import {
  createCanceledToolResult,
  createErrorToolResult,
  createInterruptedToolResult,
  type ToolInterruption,
} from "./results";
import {
  type BeforeToolExecutionResult,
  combineAbortSignals,
  type ExecutedToolCall,
  findTool,
  type InvokeOptions,
  type ToolRuntimeConfig,
} from "./types";

type Settlement = { type: "fulfilled"; value: unknown } | { type: "rejected"; error: unknown };

type RunningInvocation = {
  settlement: Promise<Settlement>;
  interruption: Promise<ToolInterruption>;
  dispose(): void;
};

type InvokerSettings = {
  config: ToolRuntimeConfig;
  events: SerialEventQueue;
  logger: Logger;
  cancellationGraceMs: number;
  defaultDeadlineMs: number;
  maxParallelToolCalls: number;
};

// Runs one tool call from validation and approval through execution,
// deadline, cancellation grace and orphan reporting.
export class ToolInvoker {
  private readonly approvals = new SerialTaskQueue();
  // run_code pauses its own deadline while a nested call waits for approval.
  private readonly approvalWaitHandlers = new Map<string, (waiting: boolean) => void>();

  constructor(private readonly settings: InvokerSettings) {}

  async invoke(toolCall: ToolCallContent, options: InvokeOptions): Promise<ExecutedToolCall> {
    const executed = await this.execute(toolCall, options);
    await this.publishEnd(executed, options.parentToolCallId);
    return executed;
  }

  async publishEnd(executed: ExecutedToolCall, parentToolCallId?: string): Promise<void> {
    await this.settings.events.emit({
      type: "tool_execution_end",
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
      result: executed.result.result,
      isError: executed.isError,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      durationMs: executed.durationMs,
    });
  }

  async execute(toolCall: ToolCallContent, options: InvokeOptions): Promise<ExecutedToolCall> {
    const { config, events, logger, cancellationGraceMs } = this.settings;
    const { groupSignal, onAbortRun, parentToolCallId } = options;
    let durationMs = 0;
    const finish = (result: ExecutedToolCall["result"], abortRun?: boolean): ExecutedToolCall => ({
      toolCall,
      result,
      isError: result.isError ?? false,
      durationMs,
      ...(abortRun === undefined ? {} : { abortRun }),
    });

    const tool = findTool(options.tools ?? config.tools, toolCall.name);
    if (!tool) {
      return finish(createErrorToolResult(`Tool "${toolCall.name}" not found`));
    }

    let acceptsUpdates = false;
    let abortRun = false;
    try {
      const args = validateToolArguments(tool, toolCall.args);
      const executionSignal = combineAbortSignals(config.signal, groupSignal);
      const approval = await this.approve(toolCall, tool, args, executionSignal, parentToolCallId);

      if (approval.type === "cancel") {
        const shouldAbortRun = approval.abortRun ?? true;
        if (shouldAbortRun) {
          onAbortRun?.();
        }
        return finish(createCanceledToolResult(approval.message), shouldAbortRun);
      }
      if (executionSignal?.aborted) {
        onAbortRun?.();
        return finish(createCanceledToolResult(), true);
      }
      if (approval.type === "return") {
        return finish(normalizeToolResult(approval.result));
      }

      const scope = parentToolCallId === undefined ? {} : { parentToolCallId };
      await events.emit({
        type: "tool_execution_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args,
        ...scope,
      });

      acceptsUpdates = true;
      const invocation = this.start(
        toolCall,
        tool,
        args,
        groupSignal,
        (partialResult) => {
          if (acceptsUpdates) {
            events.push({
              type: "tool_execution_update",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args,
              partialResult,
              ...scope,
            });
          }
        },
        (elapsedMs) => {
          durationMs = elapsedMs;
          options.onExecutionEnd?.(elapsedMs);
        },
        parentToolCallId,
      );
      const outcome = await Promise.race([
        invocation.settlement.then((settlement) => ({ type: "settled" as const, settlement })),
        invocation.interruption.then((interruption) => ({
          type: "interrupted" as const,
          interruption,
        })),
      ]);

      if (outcome.type === "interrupted") {
        acceptsUpdates = false;
        abortRun = true;
        // Stop the rolling pool before waiting for this invocation to drain;
        // otherwise another worker could claim queued work during cancellation grace.
        onAbortRun?.();
        const settlement = await settleWithin(invocation.settlement, cancellationGraceMs);
        invocation.dispose();
        await events.drain();
        const { reason } = outcome.interruption;
        if (settlement) {
          logger.info("tool.execution_cancellation_completed", {
            toolName: tool.name,
            reason,
            outcome: settlement.type,
          });
        } else {
          logger.warn("tool.execution_orphaned", {
            toolName: tool.name,
            reason,
            cancellationGraceMs,
          });
          void invocation.settlement.then((late) => {
            logger.info("tool.execution_orphan_settled", {
              toolName: tool.name,
              reason,
              outcome: late.type,
              ...(late.type === "rejected" ? errorFields(late.error) : {}),
            });
          });
        }
        return finish(
          createInterruptedToolResult(
            outcome.interruption,
            settlement ? undefined : cancellationGraceMs,
          ),
          true,
        );
      }

      invocation.dispose();
      acceptsUpdates = false;
      await events.drain();
      return outcome.settlement.type === "rejected"
        ? finish(createErrorToolResult(formatError(outcome.settlement.error)), abortRun)
        : finish(normalizeToolResult(outcome.settlement.value));
    } catch (error) {
      acceptsUpdates = false;
      // An event delivery failure outranks the original error: it means the
      // frontend may have missed part of this call's lifecycle.
      const failure = await events.drain().then(
        () => error,
        (updateError: unknown) => updateError,
      );
      return finish(createErrorToolResult(formatError(failure)), abortRun);
    }
  }

  private start(
    toolCall: ToolCallContent,
    tool: Tool,
    args: unknown,
    groupSignal: AbortSignal,
    update: (partialResult: unknown) => void,
    onExecutionEnd: (durationMs: number) => void,
    parentToolCallId?: string,
  ): RunningInvocation {
    const { config, events, logger } = this.settings;
    const deadlineMs = tool.execution?.deadlineMs ?? this.settings.defaultDeadlineMs;
    const invocationController = new AbortController();
    let interruptionValue: ToolInterruption | undefined;
    let resolveInterruption!: (interruption: ToolInterruption) => void;
    const interruption = new Promise<ToolInterruption>((resolve) => {
      resolveInterruption = resolve;
    });

    // Reported duration excludes time a run_code call spent waiting for
    // approval of its nested calls.
    let executionStartedAt: number | undefined;
    let executionEndedAt: number | undefined;
    let approvalStartedAt: number | undefined;
    let approvalWaitMs = 0;
    const finishExecution = (): void => {
      if (executionEndedAt !== undefined) return;
      executionEndedAt = performance.now();
      const waitingMs =
        approvalWaitMs +
        (approvalStartedAt === undefined ? 0 : executionEndedAt - approvalStartedAt);
      onExecutionEnd(
        executionStartedAt === undefined ? 0 : executionEndedAt - executionStartedAt - waitingMs,
      );
    };
    const interrupt = (value: ToolInterruption): void => {
      if (interruptionValue) {
        return;
      }
      interruptionValue = value;
      finishExecution();
      logger.warn("tool.execution_cancellation_requested", {
        toolName: tool.name,
        reason: value.reason,
        ...(value.reason === "deadline" ? { deadlineMs: value.deadlineMs } : {}),
      });
      invocationController.abort(
        new Error(
          value.reason === "deadline"
            ? `Tool execution exceeded its ${value.deadlineMs}ms deadline.`
            : "Agent run aborted.",
        ),
      );
      resolveInterruption(value);
    };

    const runSignals = [
      ...new Set([config.signal, groupSignal].filter((signal) => signal !== undefined)),
    ];
    const onRunAbort = (): void => interrupt({ reason: "run_aborted" });
    for (const signal of runSignals) {
      signal.addEventListener("abort", onRunAbort, { once: true });
    }
    if (runSignals.some((signal) => signal.aborted)) {
      onRunAbort();
    }

    let remainingDeadlineMs = deadlineMs;
    let deadlineStartedAt = performance.now();
    const startDeadline = (): ReturnType<typeof setTimeout> => {
      deadlineStartedAt = performance.now();
      return setTimeout(() => interrupt({ reason: "deadline", deadlineMs }), remainingDeadlineMs);
    };
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined = startDeadline();

    if (tool.name === "run_code") {
      let waitingApprovals = 0;
      this.approvalWaitHandlers.set(toolCall.id, (waiting) => {
        if (invocationController.signal.aborted) return;
        waitingApprovals += waiting ? 1 : -1;
        if (waiting && waitingApprovals === 1) {
          approvalStartedAt = performance.now();
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
          remainingDeadlineMs -= approvalStartedAt - deadlineStartedAt;
          events.push({
            type: "tool_execution_pause",
            toolCallId: toolCall.id,
            toolName: tool.name,
            reason: "approval",
          });
        } else if (!waiting && waitingApprovals === 0 && approvalStartedAt !== undefined) {
          approvalWaitMs += performance.now() - approvalStartedAt;
          approvalStartedAt = undefined;
          deadlineTimer = startDeadline();
          events.push({
            type: "tool_execution_resume",
            toolCallId: toolCall.id,
            toolName: tool.name,
            reason: "approval",
          });
        }
      });
    }

    const settlement = Promise.resolve()
      .then(() => {
        executionStartedAt = performance.now();
        return tool.execute(args, {
          toolCallId: toolCall.id,
          ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
          signal: invocationController.signal,
          update,
          ...(tool.name === "run_code"
            ? {
                invokeTool: createNestedToolInvoker((call, options) => this.invoke(call, options), {
                  parentToolCallId: toolCall.id,
                  parentSignal: invocationController.signal,
                  tools: config.callableTools ?? config.tools,
                  limit:
                    config.parallelToolCalls === false ? 1 : this.settings.maxParallelToolCalls,
                  onAbortRun: () => interrupt({ reason: "run_aborted" }),
                }),
              }
            : {}),
        });
      })
      .then(
        (value): Settlement => {
          finishExecution();
          return { type: "fulfilled", value };
        },
        (error): Settlement => {
          finishExecution();
          return { type: "rejected", error };
        },
      );

    return {
      settlement,
      interruption,
      dispose: () => {
        this.approvalWaitHandlers.delete(toolCall.id);
        for (const signal of runSignals) {
          signal.removeEventListener("abort", onRunAbort);
        }
        clearTimeout(deadlineTimer);
      },
    };
  }

  // Approvals are serialized so concurrent calls never prompt at the same time.
  private async approve(
    toolCall: ToolCallContent,
    tool: Tool,
    args: unknown,
    signal: AbortSignal | undefined,
    parentToolCallId?: string,
  ): Promise<BeforeToolExecutionResult> {
    const hook = this.settings.config.beforeToolExecution;
    if (!hook) {
      return { type: "continue" };
    }

    const waiting =
      parentToolCallId === undefined ? undefined : this.approvalWaitHandlers.get(parentToolCallId);
    waiting?.(true);
    try {
      return await this.approvals.run(() =>
        signal?.aborted
          ? { type: "cancel", abortRun: true, message: "Tool call canceled before approval." }
          : hook({ toolCall, tool, args, signal }),
      );
    } finally {
      waiting?.(false);
    }
  }
}

function settleWithin(
  settlement: Promise<Settlement>,
  timeoutMs: number,
): Promise<Settlement | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void settlement.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
