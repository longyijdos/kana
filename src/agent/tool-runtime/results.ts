import { createUserMessage, type ToolResultArtifact, type UserMessage } from "@/core";
import type { Logger } from "@/logging";
import type { ToolResult } from "@/tools";
import { errorFields } from "@/utils";
import type { ToolResultPolicy } from "../tool-result-policy";
import type { ExecutedToolCall } from "./types";

const MAX_PERSISTED_TOOL_RESULT_BYTES = 128 * 1_024;

export type ToolInterruption =
  | { reason: "run_aborted" }
  | { reason: "deadline"; deadlineMs: number };

export type FinalizedToolResult = {
  content: string;
  additionalMessages: readonly UserMessage[];
  persistResult: boolean;
  result: unknown;
  artifact?: ToolResultArtifact;
};

export function createErrorToolResult(message: string): ToolResult {
  return {
    content: `Tool call failed: ${message}`,
    result: { error: message },
    isError: true,
  };
}

export function createCancelledToolResult(
  message = "Tool call cancelled before execution.",
): ToolResult {
  return {
    content: message,
    result: { error: message, cancelled: true },
    isError: true,
  };
}

export function createUnknownToolResult(message: string, reason: string): ToolResult {
  return {
    content: message,
    result: { status: "unknown", reason, message },
    isError: true,
  };
}

export function isUnknownOutcome(executed: ExecutedToolCall | undefined): boolean {
  const result = executed?.result.result;
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "unknown"
  );
}

// `orphanedAfterMs` is set when the tool ignored cancellation for the whole
// grace period, so its side effects may still be happening.
export function createInterruptedToolResult(
  interruption: ToolInterruption,
  orphanedAfterMs?: number,
): ToolResult {
  const deadline =
    interruption.reason === "deadline" ? { deadlineMs: interruption.deadlineMs } : {};
  if (orphanedAfterMs !== undefined) {
    const message = `Tool execution was interrupted but did not stop within ${orphanedAfterMs}ms. Its outcome is unknown; do not retry automatically.`;
    return {
      content: message,
      result: { status: "unknown", reason: interruption.reason, message, ...deadline },
      isError: true,
    };
  }

  const message =
    interruption.reason === "deadline"
      ? `Tool execution exceeded its ${interruption.deadlineMs}ms deadline and was cancelled. Do not retry automatically.`
      : "Tool execution was cancelled because the agent run was aborted.";
  return {
    content: message,
    result: {
      status: interruption.reason === "deadline" ? "timed_out" : "cancelled",
      reason: interruption.reason,
      message,
      ...deadline,
    },
    isError: true,
  };
}

// Policies form one ordered pipeline. Each policy sees the previous policy's
// provider-facing text, and persistence can only become more restrictive.
export async function finalizeToolResult(
  executed: ExecutedToolCall,
  policies: readonly ToolResultPolicy[],
  options: { contentByteLimit?: number; logger: Logger },
): Promise<FinalizedToolResult> {
  let content = executed.result.content;
  let artifact: ToolResultArtifact | undefined;
  const additionalMessages: UserMessage[] = [];
  const durable = snapshotDurableResult(executed.result.result);
  let persistResult =
    durable !== undefined && durable.byteLength <= MAX_PERSISTED_TOOL_RESULT_BYTES;

  for (const policy of policies) {
    try {
      const result = await policy.finalize({
        toolCall: executed.toolCall,
        content,
        isError: executed.isError,
        resultByteLength: durable?.byteLength,
        contentByteLimit: options.contentByteLimit,
      });
      if (!result) {
        continue;
      }
      if (result.artifact && artifact) {
        throw new Error("Only one tool result artifact can be retained.");
      }
      content = result.content ?? content;
      persistResult = result.persistResult === false ? false : persistResult;
      artifact = result.artifact ?? artifact;
      for (const context of result.additionalContext ?? []) {
        additionalMessages.push(
          createUserMessage({
            content: context,
            provenance: { kind: "tool_result_policy", source: policy.source },
          }),
        );
      }
    } catch (error) {
      options.logger.warn("tool.result_policy_failed", {
        policySource: policy.source,
        toolName: executed.toolCall.name,
        ...errorFields(error),
      });
    }
  }

  return {
    content,
    additionalMessages,
    persistResult,
    result: durable?.value ?? executed.result.result,
    ...(artifact === undefined ? {} : { artifact }),
  };
}

// Tool results are arbitrary values owned by tool code. The journal keeps a
// detached copy, and a value that cannot be serialized is never persisted.
function snapshotDurableResult(value: unknown): { value: unknown; byteLength: number } | undefined {
  try {
    const snapshot = structuredClone(value);
    const serialized = JSON.stringify(snapshot);
    return {
      value: snapshot,
      byteLength: serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8"),
    };
  } catch {
    return undefined;
  }
}
