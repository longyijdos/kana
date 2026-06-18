import type { ToolCallContent } from "@/core";
import { capitalize, summarizeText } from "../render";
import { getNumberProperty, getStringProperty } from "./properties";
import { formatBashOutput } from "./renderers/bash";
import { formatEditOutput } from "./renderers/edit";
import { formatReadOutput } from "./renderers/read";
import { formatWriteOutput } from "./renderers/write";

export type ToolState = "preparing" | "running" | "done" | "failed";

type ToolApprovalText = {
  title: string;
  detail: string;
};

export function formatToolTitle(
  toolCall: ToolCallContent,
  state: ToolState,
  result: unknown,
): string {
  const target = toolTarget(toolCall, result);
  const text = toolText(toolCall.name, target);

  if (state === "preparing") {
    return `Preparing ${toolCall.name}...`;
  }

  if (state === "running") {
    return `${capitalize(text.runningActivity)}... (Esc to abort)`;
  }

  if (state === "failed") {
    return `Failed to ${text.action}`;
  }

  return text.doneTitle;
}

export function formatToolApproval(toolCall: ToolCallContent): ToolApprovalText {
  return {
    title: formatToolApprovalTitle(toolCall),
    detail: formatToolDetail(toolCall),
  };
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

function toolTarget(toolCall: ToolCallContent, result?: unknown): string {
  const path = getStringProperty(toolCall.args, "path");
  const resultPath = getStringProperty(result, "path");
  const command = getStringProperty(toolCall.args, "command");
  const resultCommand = getStringProperty(result, "command");

  if (resultPath || path) {
    return resultPath ?? path ?? toolCall.name;
  }

  if (resultCommand || command) {
    return resultCommand ?? command ?? toolCall.name;
  }

  return toolCall.name;
}

function formatToolApprovalTitle(toolCall: ToolCallContent): string {
  return toolText(toolCall.name, toolCall.name).approvalTitle;
}

function formatToolDetail(toolCall: ToolCallContent): string {
  const target = toolTarget(toolCall);
  const summary = formatToolSummary(toolCall);

  return summary ? `${target} - ${summary}` : target;
}

function formatToolSummary(toolCall: ToolCallContent): string {
  switch (toolCall.name) {
    case "read": {
      const startLine = getNumberProperty(toolCall.args, "startLine");
      const endLine = getNumberProperty(toolCall.args, "endLine");

      return startLine !== undefined || endLine !== undefined
        ? `lines ${startLine ?? "start"}-${endLine ?? "end"}`
        : "";
    }

    case "write": {
      const content = getStringProperty(toolCall.args, "content");

      return content ? summarizeText(content) : "";
    }

    case "edit": {
      const oldText = getStringProperty(toolCall.args, "oldText");

      return oldText ? `replace ${summarizeText(oldText)}` : "";
    }

    case "bash": {
      const cwd = getStringProperty(toolCall.args, "cwd");

      return cwd ? `cwd ${cwd}` : "";
    }
  }

  if (toolCall.args === undefined) {
    return "";
  }

  try {
    return JSON.stringify(toolCall.args);
  } catch {
    return String(toolCall.args);
  }
}

function formatErrorOutput(result: object): string {
  const error = getStringProperty(result, "error");

  return error ?? JSON.stringify(result, null, 2);
}

function toolText(
  toolName: string,
  target: string,
): {
  action: string;
  approvalTitle: string;
  doneTitle: string;
  runningActivity: string;
} {
  switch (toolName) {
    case "read":
      return {
        action: `read ${target}`,
        approvalTitle: "Allow agent to read file?",
        doneTitle: `Read ${target}`,
        runningActivity: `reading ${target}`,
      };
    case "write":
      return {
        action: `create ${target}`,
        approvalTitle: "Allow agent to create file?",
        doneTitle: `Created ${target}`,
        runningActivity: `creating ${target}`,
      };
    case "edit":
      return {
        action: `edit ${target}`,
        approvalTitle: "Allow agent to edit file?",
        doneTitle: `Edited ${target}`,
        runningActivity: `editing ${target}`,
      };
    case "bash":
      return {
        action: `run ${target}`,
        approvalTitle: "Allow agent to run bash?",
        doneTitle: `Ran ${target}`,
        runningActivity: `running ${target}`,
      };
    default:
      return {
        action: `use ${toolName}`,
        approvalTitle: `Allow agent to use ${toolName}?`,
        doneTitle: `Used ${toolName}`,
        runningActivity: `using ${toolName}`,
      };
  }
}
