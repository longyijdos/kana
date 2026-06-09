import type { ToolCallContent } from "../../../../core/messages";
import { formatBashOutput } from "./bash";
import { formatEditOutput } from "./edit";
import { formatReadOutput } from "./read";
import {
  getStringProperty,
  toolTarget,
} from "./shared";
import { formatWriteOutput } from "./write";

export type ToolState = "preparing" | "running" | "done" | "failed";

export function formatToolTitle(
  toolCall: ToolCallContent,
  state: ToolState,
  result: unknown,
): string {
  const target = toolTarget(toolCall, result);

  if (state === "preparing") {
    return `Preparing ${toolCall.name}...`;
  }

  if (state === "running") {
    return `${capitalize(formatRunningToolActivity(toolCall, target))}...`;
  }

  if (state === "failed") {
    return `Failed to ${formatToolAction(toolCall, target)}`;
  }

  switch (toolCall.name) {
    case "read":
      return `Read ${target}`;
    case "write":
      return `Created ${target}`;
    case "edit":
      return `Edited ${target}`;
    case "bash":
      return `Ran ${target}`;
    default:
      return `Used ${toolCall.name}`;
  }
}

export function formatToolOutput(
  toolCall: ToolCallContent,
  result: unknown,
  isError: boolean,
): string | string[] {
  if (!result || typeof result !== "object") {
    return result === undefined ? "" : String(result);
  }

  if (isError) {
    return formatErrorOutput(result);
  }

  switch (toolCall.name) {
    case "read":
      return formatReadOutput(result);
    case "write":
      return formatWriteOutput(toolCall, result);
    case "edit":
      return formatEditOutput(result);
    case "bash":
      return formatBashOutput(result);
  }

  return JSON.stringify(result, null, 2);
}

export function formatToolApprovalTitle(toolCall: ToolCallContent): string {
  const target = toolTarget(toolCall);

  return `Allow agent to ${formatToolAction(toolCall, target)}?`;
}

function formatErrorOutput(result: object): string {
  const error = getStringProperty(result, "error");

  return error ?? JSON.stringify(result, null, 2);
}

function formatRunningToolActivity(toolCall: ToolCallContent, target: string): string {
  switch (toolCall.name) {
    case "read":
      return `reading ${target}`;
    case "write":
      return `creating ${target}`;
    case "edit":
      return `editing ${target}`;
    case "bash":
      return `running ${target}`;
    default:
      return `using ${toolCall.name}`;
  }
}

function formatToolAction(toolCall: ToolCallContent, target: string): string {
  switch (toolCall.name) {
    case "read":
      return `read ${target}`;
    case "write":
      return `create ${target}`;
    case "edit":
      return `edit ${target}`;
    case "bash":
      return `run ${target}`;
    default:
      return `use ${toolCall.name}`;
  }
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}
