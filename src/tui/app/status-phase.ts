import type { AgentEvent } from "@/agent";
import type { AssistantMessage } from "@/core";

export type RunPhase =
  | "idle"
  | "starting"
  | "compacting"
  | "working"
  | "searching"
  | "responding"
  | "tool"
  | "done"
  | "aborted"
  | "error"
  | "length"
  | "turn_limit";

export function phaseForAssistantMessage(message: AssistantMessage): RunPhase {
  if (message.content.some((content) => content.type === "tool_call")) {
    return "tool";
  }

  if (
    message.content.some(
      (content) => content.type === "hosted_tool" && content.status === "in_progress",
    )
  ) {
    return "searching";
  }

  if (message.content.some((content) => content.type === "text" && content.text)) {
    return "responding";
  }

  return "working";
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
