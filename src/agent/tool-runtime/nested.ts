import type { ToolCallContent } from "@/core";
import type { CodemodeToolContext, Tool, ToolConcurrency, ToolResult } from "@/tools";
import { combineAbortSignals, type ExecutedToolCall, findTool, type InvokeOptions } from "./types";

type QueuedCall = {
  toolCall: ToolCallContent;
  signal: AbortSignal;
  concurrency: ToolConcurrency;
  onExecutionEnd?: (durationMs: number) => void;
  resolve(result: ToolResult): void;
  reject(error: unknown): void;
};

// Schedules the tool calls a run_code script makes. Parallel tools share up to
// `limit` slots; an exclusive tool waits for running calls and runs alone.
export function createNestedToolInvoker(
  invoke: (toolCall: ToolCallContent, options: InvokeOptions) => Promise<ExecutedToolCall>,
  options: {
    parentToolCallId: string;
    parentSignal: AbortSignal;
    tools: readonly Tool[] | undefined;
    limit: number;
    onAbortRun: () => void;
  },
): CodemodeToolContext["invokeTool"] {
  const queue: QueuedCall[] = [];
  let activeCount = 0;
  let exclusiveActive = false;

  const drain = (): void => {
    while (!exclusiveActive && activeCount < options.limit) {
      const next = queue[0];
      if (!next || (next.concurrency === "exclusive" && activeCount > 0)) return;
      queue.shift();
      activeCount += 1;
      exclusiveActive = next.concurrency === "exclusive";
      void invoke(next.toolCall, {
        groupSignal: next.signal,
        tools: options.tools,
        parentToolCallId: options.parentToolCallId,
        onExecutionEnd: next.onExecutionEnd,
        onAbortRun: () => {
          // The sandbox also cancels unawaited calls after normal script completion.
          if (!next.signal.aborted) options.onAbortRun();
        },
      })
        .then((executed) => next.resolve(executed.result), next.reject)
        .finally(() => {
          activeCount -= 1;
          exclusiveActive = false;
          drain();
        });
    }
  };

  return (name, args, callOptions = {}) =>
    new Promise<ToolResult>((resolve, reject) => {
      queue.push({
        toolCall: { type: "tool_call", id: crypto.randomUUID(), name, args },
        signal:
          combineAbortSignals(options.parentSignal, callOptions.signal) ?? options.parentSignal,
        concurrency: findTool(options.tools, name)?.execution?.concurrency ?? "exclusive",
        onExecutionEnd: callOptions.onExecutionEnd,
        resolve,
        reject,
      });
      drain();
    });
}
