import type { AgentEvent } from "@/agent";
import type { AssistantMessage } from "@/core";

export type RunPhase =
  | "idle"
  | "starting"
  | "thinking"
  | "responding"
  | "tool"
  | "done"
  | "aborted"
  | "error"
  | "length";

export function phaseForAssistantMessage(message: AssistantMessage): RunPhase {
  if (message.content.some((content) => content.type === "tool_call")) {
    return "tool";
  }

  if (message.content.some((content) => content.type === "text" && content.text)) {
    return "responding";
  }

  return "thinking";
}

export function isThinkingVisible(
  eventType: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"]["type"],
): boolean {
  switch (eventType) {
    case "thinking_start":
    case "thinking_delta":
      return true;
    default:
      return false;
  }
}

export function phaseForStopReason(
  reason: AssistantMessage["stopReason"],
): RunPhase {
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
    case "stop":
      return "done";
  }
}
