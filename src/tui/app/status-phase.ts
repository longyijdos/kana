import type { AgentEvent } from "@/agent";
import type { AssistantMessage } from "@/core";

export type RunPhase =
  | "idle"
  | "starting"
  | "compacting"
  | "thinking"
  | "searching"
  | "responding"
  | "tool"
  | "done"
  | "aborted"
  | "error"
  | "length"
  | "turn_limit";

export function phaseForAssistantMessage(message: AssistantMessage): RunPhase {
  if (
    message.content.some(
      (content) => content.type === "hosted_tool" && content.status === "in_progress",
    )
  ) {
    return "searching";
  }

  if (message.content.some((content) => content.type === "tool_call")) {
    return "thinking";
  }

  if (message.content.some((content) => content.type === "text" && content.text)) {
    return "responding";
  }

  return "thinking";
}

export function isThinkingVisible(
  eventType: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"]["type"],
  hostedActivityActive = false,
): boolean {
  switch (eventType) {
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
      // Provider reasoning between hosted actions belongs to the still-open
      // search phase and must not make Searched/Searching oscillate.
      return !hostedActivityActive;
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      // Local-call argument streaming extends provider-side Thinking activity.
      // Local execution begins later at tool_execution_start.
      return true;
    default:
      return false;
  }
}

export function phaseForStopReason(reason: AssistantMessage["stopReason"]): RunPhase {
  switch (reason) {
    case "length":
      return "length";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "toolUse":
      return "tool";
    case "stop":
    case undefined:
      return "done";
  }
}

export function phaseForAgentEndReason(
  reason: Extract<AgentEvent, { type: "agent_end" }>["reason"],
): RunPhase {
  switch (reason) {
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "length":
      return "length";
    case "turn_limit":
      return "turn_limit";
    case "stop":
      return "done";
  }
}
