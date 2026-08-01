import type { Message, ToolCallContent, ToolResultMessage } from "@/core";
import type { Logger, LogMetadata } from "@/logging";
import {
  normalizeToolResult,
  type Tool,
  type ToolConcurrency,
  type ToolResult,
  validateToolArguments,
} from "@/tools";
import type { AgentEvent } from "./events";

const DEFAULT_CANCELLATION_GRACE_MS = 1_000;
export const DEFAULT_TOOL_DEADLINE_MS = 300_000;

export type BeforeToolExecutionResult =
  | {
      type: "continue";
    }
  | {
      type: "cancel";
      abortRun?: boolean;
      message?: string;
    };

export type BeforeToolExecutionHook = (request: {
  toolCall: ToolCallContent;
  tool: Tool;
  args: unknown;
  signal?: AbortSignal;
}) => Promise<BeforeToolExecutionResult> | BeforeToolExecutionResult;

export type ToolRuntimeConfig = {
  tools?: readonly Tool[];
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  beforeToolExecution?: BeforeToolExecutionHook;
  cancellationGraceMs?: number;
  defaultDeadlineMs?: number;
  logger?: Logger;
  loggerMetadata?: LogMetadata;
  onMessageCommitted?: (message: Message) => Promise<void> | void;
  limitToolContent?: (content: string) => string;
};

export type ToolRuntimeResult = {
  toolResults: ToolResultMessage[];
  abortRun: boolean;
};

type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

type ExecutedToolCall = {
  toolCall: ToolCallContent;
  result: ToolResult;
  isError: boolean;
  abortRun?: boolean;
};

type ToolInterruption =
  | {
      reason: "run_aborted";
    }
  | {
      reason: "deadline";
      deadlineMs: number;
    };

type ToolExecutionSettlement =
  | {
      type: "fulfilled";
      value: unknown;
    }
  | {
      type: "rejected";
      error: unknown;
    };

export class ToolRuntime {
  private readonly events: SerialEventQueue;
  private readonly approvals = new SerialTaskQueue();
  private readonly cancellationGraceMs: number;
  private readonly defaultDeadlineMs: number;
  private resultCommitFailure?: { error: unknown };
  private resultCommitTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ToolRuntimeConfig,
    emit: AgentEventSink,
  ) {
    this.events = new SerialEventQueue(emit);
    this.cancellationGraceMs = resolveCancellationGraceMs(config.cancellationGraceMs);
    this.defaultDeadlineMs = resolveDefaultToolDeadlineMs(config.defaultDeadlineMs);
  }

  async execute(toolCalls: ToolCallContent[]): Promise<ToolRuntimeResult> {
    const toolResults: ToolResultMessage[] = [];
    let abortRun = false;
    let index = 0;

    while (index < toolCalls.length) {
      if (this.config.signal?.aborted) {
        await this.appendCanceledResults(
          toolResults,
          toolCalls.slice(index),
          "Tool call canceled because the run was aborted.",
        );
        abortRun = true;
        break;
      }

      const group = this.readExecutionGroup(toolCalls, index);
      const executedGroup = await this.executeGroup(group);
      toolResults.push(...executedGroup.toolResults);
      index += group.length;

      if (executedGroup.abortRun) {
        await this.appendCanceledResults(
          toolResults,
          toolCalls.slice(index),
          "Tool call canceled because the run was aborted.",
        );
        abortRun = true;
        break;
      }
    }

    return {
      toolResults,
      abortRun,
    };
  }

  private readExecutionGroup(toolCalls: ToolCallContent[], startIndex: number): ToolCallContent[] {
    if (this.config.parallelToolCalls === false) {
      const toolCall = toolCalls[startIndex];
      return toolCall ? [toolCall] : [];
    }

    // Only adjacent parallel calls share a group. Exclusive and undeclared
    // tools are barriers, so read work cannot cross a side-effecting call.
    const firstCall = toolCalls[startIndex];
    if (!firstCall || this.readToolConcurrency(firstCall) === "exclusive") {
      return firstCall ? [firstCall] : [];
    }

    let endIndex = startIndex + 1;
    while (
      endIndex < toolCalls.length &&
      this.readToolConcurrency(toolCalls[endIndex] as ToolCallContent) === "parallel"
    ) {
      endIndex += 1;
    }
    return toolCalls.slice(startIndex, endIndex);
  }

  private readToolConcurrency(toolCall: ToolCallContent): ToolConcurrency {
    const tool = this.config.tools?.find((candidate) => candidate.name === toolCall.name);
    try {
      return tool ? resolveToolConcurrency(tool) : "exclusive";
    } catch {
      // Invalid or unknown metadata must fail closed as an exclusive barrier.
      return "exclusive";
    }
  }

  private async executeGroup(toolCalls: ToolCallContent[]): Promise<ToolRuntimeResult> {
    const groupController = new AbortController();
    const toolResults: ToolResultMessage[] = [];
    let abortRun = false;

    if (toolCalls.length > 1) {
      this.log("debug", "tool.parallel_group_started", {
        toolCount: toolCalls.length,
      });
    }

    const executions = toolCalls.map(async (toolCall) => {
      try {
        const executed = await this.executeToolCall(toolCall, groupController.signal);
        if (executed.abortRun) {
          abortRun = true;
          groupController.abort();
        }
        // Push after the serialized durable commit so the model sees results
        // in completion order without allowing concurrent journal appends.
        const message = await this.enqueueResultCommit(executed);
        toolResults.push(message);
      } catch (error) {
        groupController.abort();
        throw error;
      }
    });
    const settlements = await Promise.allSettled(executions);
    const failure = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );

    if (toolCalls.length > 1) {
      this.log("debug", "tool.parallel_group_ended", {
        toolCount: toolCalls.length,
        outcome: failure ? "failed" : abortRun ? "aborted" : "completed",
      });
    }
    if (failure) {
      throw failure.reason;
    }

    return {
      toolResults,
      abortRun,
    };
  }

  private async appendCanceledResults(
    toolResults: ToolResultMessage[],
    toolCalls: ToolCallContent[],
    message: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      toolResults.push(
        await this.enqueueResultCommit({
          toolCall,
          result: createCanceledToolResult(message),
          isError: true,
        }),
      );
    }
  }

  private async executeToolCall(
    toolCall: ToolCallContent,
    groupSignal: AbortSignal,
  ): Promise<ExecutedToolCall> {
    const tool = this.config.tools?.find((candidate) => candidate.name === toolCall.name);

    if (!tool) {
      return {
        toolCall,
        result: createErrorToolResult(`Tool "${toolCall.name}" not found`),
        isError: true,
      };
    }

    let acceptsUpdates = false;
    let abortRun = false;
    try {
      resolveToolConcurrency(tool);
      const deadlineMs = resolveInvocationDeadlineMs(tool, this.defaultDeadlineMs);
      const args = validateToolArguments(tool, toolCall.args);
      const executionSignal = combineAbortSignals(this.config.signal, groupSignal);
      const beforeResult = await this.runBeforeToolExecution(toolCall, tool, args, executionSignal);

      if (beforeResult.type === "cancel") {
        return {
          toolCall,
          result: createCanceledToolResult(beforeResult.message),
          isError: true,
          abortRun: beforeResult.abortRun ?? true,
        };
      }

      if (executionSignal?.aborted) {
        return {
          toolCall,
          result: createCanceledToolResult("Tool call canceled before execution."),
          isError: true,
          abortRun: true,
        };
      }

      await this.events.emit({
        type: "tool_execution_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args,
      });

      acceptsUpdates = true;
      const invocation = this.startToolExecution(
        toolCall,
        tool,
        args,
        deadlineMs,
        groupSignal,
        (partialResult) => {
          if (!acceptsUpdates) {
            return;
          }
          this.events.push({
            type: "tool_execution_update",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args,
            partialResult,
          });
        },
      );
      const firstOutcome = await Promise.race([
        invocation.settlement.then((settlement) => ({
          type: "settled" as const,
          settlement,
        })),
        invocation.interruption.then((interruption) => ({
          type: "interrupted" as const,
          interruption,
        })),
      ]);

      if (firstOutcome.type === "interrupted") {
        acceptsUpdates = false;
        abortRun = true;
        const settlement = await waitForSettlementWithin(
          invocation.settlement,
          this.cancellationGraceMs,
        );
        invocation.dispose();
        await this.events.drain();

        if (settlement) {
          this.log("info", "tool.execution_cancellation_completed", {
            toolName: tool.name,
            reason: firstOutcome.interruption.reason,
            outcome: settlement.type,
          });
          return {
            toolCall,
            result: createInterruptedToolResult(firstOutcome.interruption, false),
            isError: true,
            abortRun: true,
          };
        }

        this.log("warn", "tool.execution_orphaned", {
          toolName: tool.name,
          reason: firstOutcome.interruption.reason,
          cancellationGraceMs: this.cancellationGraceMs,
        });
        void invocation.settlement.then((lateSettlement) => {
          this.log("info", "tool.execution_orphan_settled", {
            toolName: tool.name,
            reason: firstOutcome.interruption.reason,
            outcome: lateSettlement.type,
            ...(lateSettlement.type === "rejected"
              ? { errorType: getErrorType(lateSettlement.error) }
              : {}),
          });
        });
        return {
          toolCall,
          result: createInterruptedToolResult(
            firstOutcome.interruption,
            true,
            this.cancellationGraceMs,
          ),
          isError: true,
          abortRun: true,
        };
      }

      invocation.dispose();
      acceptsUpdates = false;
      await this.events.drain();

      if (firstOutcome.settlement.type === "rejected") {
        throw firstOutcome.settlement.error;
      }
      const result = normalizeToolResult(firstOutcome.settlement.value);
      return {
        toolCall,
        result,
        isError: result.isError ?? false,
      };
    } catch (error) {
      acceptsUpdates = false;
      try {
        await this.events.drain();
      } catch (updateError) {
        return {
          toolCall,
          result: createErrorToolResult(formatError(updateError)),
          isError: true,
          abortRun,
        };
      }
      return {
        toolCall,
        result: createErrorToolResult(formatError(error)),
        isError: true,
        abortRun,
      };
    }
  }

  private startToolExecution(
    toolCall: ToolCallContent,
    tool: Tool,
    args: unknown,
    deadlineMs: number | undefined,
    groupSignal: AbortSignal,
    update: (partialResult: unknown) => void,
  ): {
    settlement: Promise<ToolExecutionSettlement>;
    interruption: Promise<ToolInterruption>;
    dispose(): void;
  } {
    const invocationController = new AbortController();
    let interruptionValue: ToolInterruption | undefined;
    let resolveInterruption!: (interruption: ToolInterruption) => void;
    const interruption = new Promise<ToolInterruption>((resolve) => {
      resolveInterruption = resolve;
    });
    const interrupt = (value: ToolInterruption): void => {
      if (interruptionValue) {
        return;
      }

      interruptionValue = value;
      this.log("warn", "tool.execution_cancellation_requested", {
        toolName: tool.name,
        reason: value.reason,
        ...(value.reason === "deadline" ? { deadlineMs: value.deadlineMs } : {}),
      });
      invocationController.abort(createInterruptionError(value));
      resolveInterruption(value);
    };
    const runSignals = [...new Set([this.config.signal, groupSignal].filter(isAbortSignal))];
    const onRunAbort = (): void => interrupt({ reason: "run_aborted" });

    for (const signal of runSignals) {
      signal.addEventListener("abort", onRunAbort, { once: true });
    }
    if (runSignals.some((signal) => signal.aborted)) {
      onRunAbort();
    }
    const deadlineTimer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(() => interrupt({ reason: "deadline", deadlineMs }), deadlineMs);
    const settlement = Promise.resolve()
      .then(() =>
        tool.execute(args, {
          toolCallId: toolCall.id,
          signal: invocationController.signal,
          update,
        }),
      )
      .then(
        (value): ToolExecutionSettlement => ({
          type: "fulfilled",
          value,
        }),
        (error): ToolExecutionSettlement => ({
          type: "rejected",
          error,
        }),
      );

    return {
      settlement,
      interruption,
      dispose() {
        for (const signal of runSignals) {
          signal.removeEventListener("abort", onRunAbort);
        }
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer);
        }
      },
    };
  }

  private async runBeforeToolExecution(
    toolCall: ToolCallContent,
    tool: Tool,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    const hook = this.config.beforeToolExecution;
    if (!hook) {
      return {
        type: "continue",
      };
    }

    return this.approvals.run(() => {
      if (signal?.aborted) {
        return {
          type: "cancel",
          abortRun: true,
          message: "Tool call canceled before approval.",
        };
      }

      return hook({
        toolCall,
        tool,
        args,
        signal,
      });
    });
  }

  private enqueueResultCommit(executed: ExecutedToolCall): Promise<ToolResultMessage> {
    const committed = this.resultCommitTail.then(async () => {
      if (this.resultCommitFailure) {
        throw this.resultCommitFailure.error;
      }
      try {
        return await this.commitResult(executed);
      } catch (error) {
        this.resultCommitFailure = { error };
        throw error;
      }
    });
    this.resultCommitTail = committed.then(
      () => undefined,
      () => undefined,
    );
    return committed;
  }

  private async commitResult(executed: ExecutedToolCall): Promise<ToolResultMessage> {
    const message: ToolResultMessage = {
      role: "tool",
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
      content: this.config.limitToolContent?.(executed.result.content) ?? executed.result.content,
      result: executed.result.result,
      isError: executed.isError,
    };

    // A successful end event must never become visible before the result can
    // be recovered from the journal.
    await this.config.onMessageCommitted?.(structuredClone(message));
    await this.events.emit({
      type: "tool_execution_end",
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
      result: executed.result.result,
      isError: executed.isError,
    });
    return message;
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    metadata?: LogMetadata,
  ): void {
    const mergedMetadata = {
      ...this.config.loggerMetadata,
      ...metadata,
    };

    try {
      this.config.logger?.[level](
        event,
        Object.keys(mergedMetadata).length === 0 ? undefined : mergedMetadata,
      );
    } catch {
      // Diagnostics must not alter tool execution or cleanup behavior.
    }
  }
}

class SerialEventQueue {
  private tail: Promise<void> = Promise.resolve();
  private firstError: unknown;

  constructor(private readonly emitEvent: AgentEventSink) {}

  push(event: AgentEvent): void {
    this.tail = this.tail.then(async () => {
      try {
        await this.emitEvent(event);
      } catch (error) {
        this.firstError ??= error;
      }
    });
  }

  async emit(event: AgentEvent): Promise<void> {
    this.push(event);
    await this.drain();
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.firstError === undefined) {
      return;
    }

    const error = this.firstError;
    this.firstError = undefined;
    throw error;
  }
}

class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function createErrorToolResult(message: string): ToolResult {
  return {
    content: `Tool call failed: ${message}`,
    result: {
      error: message,
    },
    isError: true,
  };
}

function createCanceledToolResult(message = "Tool call canceled before execution."): ToolResult {
  return {
    content: message,
    result: {
      error: message,
      canceled: true,
    },
    isError: true,
  };
}

function createInterruptedToolResult(
  interruption: ToolInterruption,
  orphaned: boolean,
  cancellationGraceMs?: number,
): ToolResult {
  if (orphaned) {
    const message = `Tool execution was interrupted but did not stop within ${cancellationGraceMs}ms. Its outcome is unknown; do not retry automatically.`;
    return {
      content: message,
      result: {
        status: "unknown",
        reason: interruption.reason,
        message,
        ...(interruption.reason === "deadline" ? { deadlineMs: interruption.deadlineMs } : {}),
      },
      isError: true,
    };
  }

  const message =
    interruption.reason === "deadline"
      ? `Tool execution exceeded its ${interruption.deadlineMs}ms deadline and was canceled. Do not retry automatically.`
      : "Tool execution was canceled because the agent run was aborted.";
  return {
    content: message,
    result: {
      status: interruption.reason === "deadline" ? "timed_out" : "canceled",
      reason: interruption.reason,
      message,
      ...(interruption.reason === "deadline" ? { deadlineMs: interruption.deadlineMs } : {}),
    },
    isError: true,
  };
}

function resolveInvocationDeadlineMs(tool: Tool, defaultDeadlineMs: number): number {
  const deadlineMs = tool.execution?.deadlineMs;
  if (deadlineMs === undefined) {
    return defaultDeadlineMs;
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`Tool "${tool.name}" execution.deadlineMs must be a positive integer.`);
  }
  return deadlineMs;
}

export function resolveDefaultToolDeadlineMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TOOL_DEADLINE_MS;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("defaultDeadlineMs must be a positive integer.");
  }
  return value;
}

function resolveToolConcurrency(tool: Tool): ToolConcurrency {
  const concurrency = tool.execution?.concurrency ?? "exclusive";
  if (concurrency !== "parallel" && concurrency !== "exclusive") {
    throw new Error(`Tool "${tool.name}" execution.concurrency must be "parallel" or "exclusive".`);
  }
  return concurrency;
}

function resolveCancellationGraceMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CANCELLATION_GRACE_MS;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("cancellationGraceMs must be a positive integer.");
  }
  return value;
}

function waitForSettlementWithin(
  settlement: Promise<ToolExecutionSettlement>,
  timeoutMs: number,
): Promise<ToolExecutionSettlement | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    void settlement.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function createInterruptionError(interruption: ToolInterruption): Error {
  return new Error(
    interruption.reason === "deadline"
      ? `Tool execution exceeded its ${interruption.deadlineMs}ms deadline.`
      : "Agent run aborted.",
  );
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) {
    return second;
  }
  if (!second || first === second) {
    return first;
  }
  return AbortSignal.any([first, second]);
}

function isAbortSignal(value: AbortSignal | undefined): value is AbortSignal {
  return value !== undefined;
}

function getErrorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
