import type { Message, ToolCallContent } from "@/core";
import type { Logger } from "@/logging";
import type { Tool, ToolResult } from "@/tools";
import type { AgentEvent } from "../events";
import type { ToolResultPolicy } from "../tool-result-policy";

export type BeforeToolExecutionResult =
  | { type: "continue" }
  | { type: "cancel"; abortRun?: boolean; message?: string }
  | { type: "return"; result: ToolResult & { isError?: false } };

export type BeforeToolExecutionHook = (request: {
  toolCall: ToolCallContent;
  tool: Tool;
  args: unknown;
  signal?: AbortSignal;
}) => Promise<BeforeToolExecutionResult> | BeforeToolExecutionResult;

export type ToolRuntimeConfig = {
  tools?: readonly Tool[];
  // Tools reachable from run_code; defaults to `tools`.
  callableTools?: readonly Tool[];
  parallelToolCalls?: boolean;
  maxParallelToolCalls?: number;
  signal?: AbortSignal;
  beforeToolExecution?: BeforeToolExecutionHook;
  cancellationGraceMs?: number;
  defaultDeadlineMs?: number;
  logger?: Logger;
  onMessageCommitted?: (message: Message) => Promise<void> | void;
  limitToolContent?: (content: string) => string;
  toolContentByteLimit?: number;
  toolResultPolicies?: readonly ToolResultPolicy[];
};

export type ExecutedToolCall = {
  toolCall: ToolCallContent;
  result: ToolResult;
  isError: boolean;
  durationMs: number;
  abortRun?: boolean;
};

export type InvokeOptions = {
  groupSignal: AbortSignal;
  tools?: readonly Tool[];
  // Called as soon as the call decides the run must stop, before it settles.
  onAbortRun?: () => void;
  parentToolCallId?: string;
  onExecutionEnd?: (durationMs: number) => void;
};

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export function findTool(tools: readonly Tool[] | undefined, name: string): Tool | undefined {
  return tools?.find((tool) => tool.name === name);
}

export function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first || first === second) {
    return second;
  }
  return second ? AbortSignal.any([first, second]) : first;
}
