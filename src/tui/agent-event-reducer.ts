import React from "react";
import type { AgentEvent } from "../agent";
import type { AssistantMessageEvent } from "../core/events";
import type { AssistantStopReason } from "../core/messages";
import { appendLine, appendToLastLine } from "./transcript/transcript-state";
import type { LogLine, RunStatus } from "./types";

export function handleAgentEvent(
  event: AgentEvent,
  nextId: React.MutableRefObject<number>,
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
  setStatus: React.Dispatch<React.SetStateAction<RunStatus>>,
): void {
  switch (event.type) {
    case "agent_start":
      setStatus((current) => ({
        ...current,
        phase: "starting",
      }));
      break;
    case "agent_end":
      setStatus((current) => ({
        ...current,
        phase: phaseForStopReason(lastAssistantStopReason(event.messages)),
        activeTool: undefined,
      }));
      break;
    case "turn_start":
      setStatus((current) => ({
        ...current,
        phase: "thinking",
        turn: event.turn,
        activeTool: undefined,
      }));
      break;
    case "turn_end":
      setStatus((current) => ({
        ...current,
        turn: event.turn,
        activeTool: undefined,
      }));
      break;
    case "message_start":
      setStatus((current) => ({
        ...current,
        phase: "thinking",
      }));
      break;
    case "message_update":
      handleAssistantEvent(
        event.assistantMessageEvent,
        nextId,
        setLines,
        setStatus,
      );
      break;
    case "message_end":
      setStatus((current) => ({
        ...current,
        phase: phaseForStopReason(event.message.stopReason),
        activeTool: undefined,
      }));
      break;
    case "tool_execution_start":
      setStatus((current) => ({
        ...current,
        phase: "tool",
        activeTool: formatToolActivity(event.toolName, event.args),
      }));
      appendLine(
        nextId,
        setLines,
        "tool",
        `tool ${formatToolActivity(event.toolName, event.args)}`,
      );
      break;
    case "tool_execution_update":
      setStatus((current) => ({
        ...current,
        phase: "tool",
        activeTool: event.toolName,
      }));
      break;
    case "tool_execution_end":
      appendLine(
        nextId,
        setLines,
        event.isError ? "error" : "tool",
        `${event.isError ? "tool failed" : "tool done"} ${event.toolName}${formatToolResultSummary(event.result)}`,
      );
      break;
  }
}

function handleAssistantEvent(
  event: AssistantMessageEvent,
  nextId: React.MutableRefObject<number>,
  setLines: React.Dispatch<React.SetStateAction<LogLine[]>>,
  setStatus: React.Dispatch<React.SetStateAction<RunStatus>>,
): void {
  switch (event.type) {
    case "thinking_start":
      setStatus((current) => ({
        ...current,
        phase: "thinking",
      }));
      appendLine(nextId, setLines, "thinking", "thinking...");
      break;
    case "thinking_delta":
      break;
    case "text_start":
      setStatus((current) => ({
        ...current,
        phase: "responding",
        activeTool: undefined,
      }));
      appendLine(nextId, setLines, "assistant", "assistant: ");
      break;
    case "text_delta":
      appendToLastLine(setLines, "assistant", event.delta);
      break;
    case "toolcall_start":
      setStatus((current) => ({
        ...current,
        phase: "tool",
      }));
      break;
    case "toolcall_delta":
      break;
    case "toolcall_end":
      setStatus((current) => ({
        ...current,
        phase: "tool",
        activeTool: formatToolActivity(event.toolCall.name, event.toolCall.args),
      }));
      break;
    case "thinking_end":
    case "text_end":
    case "start":
    case "done":
    case "error":
      break;
  }
}

function lastAssistantStopReason(
  messages: Extract<AgentEvent, { type: "agent_end" }>["messages"],
): AssistantStopReason | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "assistant") {
      return message.stopReason;
    }
  }

  return undefined;
}

function phaseForStopReason(
  reason: AssistantStopReason | undefined,
): RunStatus["phase"] {
  switch (reason) {
    case "stop":
      return "done";
    case "toolUse":
      return "tool";
    case "length":
      return "length";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case undefined:
      return "done";
  }
}

function formatToolActivity(toolName: string, args: unknown): string {
  const pathArg = getStringProperty(args, "path");
  const commandArg = getStringProperty(args, "command");

  if (pathArg) {
    return `${toolName} ${pathArg}`;
  }

  if (commandArg) {
    return `${toolName} ${commandArg}`;
  }

  return toolName;
}

function formatToolResultSummary(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const path = getStringProperty(result, "path");
  const command = getStringProperty(result, "command");
  const exitCode = getNumberProperty(result, "exitCode");

  if (path) {
    return ` ${path}`;
  }

  if (command) {
    return ` ${command}${exitCode === undefined ? "" : ` exit=${exitCode}`}`;
  }

  return "";
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "string" ? property : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "number" ? property : undefined;
}
