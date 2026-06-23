import type { ToolCallContent } from "@/core";
import {
  capitalize,
  color,
  stripTerminalControlSequences,
  summarizeText,
  wrapPlainText,
} from "../render";
import { tuiTheme } from "../theme";
import { getNumberProperty, getStringProperty } from "./properties";
import { formatBashOutput, hasExpandableBashOutput } from "./renderers/bash";
import { formatEditOutput } from "./renderers/edit";
import { formatReadOutput, hasExpandableReadOutput } from "./renderers/read";
import { formatWriteOutput, hasExpandableWriteOutput } from "./renderers/write";

export type ToolState = "preparing" | "running" | "done" | "failed";
export type ToolOutputDetail = "compact" | "full";
export type ToolTranscriptTitle = { activity: string; hint?: string; target?: string };

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

export function formatToolTranscriptTitle(
  toolCall: ToolCallContent,
  state: ToolState,
  result: unknown,
  elapsedSeconds?: number,
): ToolTranscriptTitle {
  const target = toolTarget(toolCall, result);
  const text = toolText(toolCall.name, target);
  const action = text.action.replace(` ${target}`, "");
  const runningActivity = capitalize(text.runningActivity.replace(` ${target}`, ""));

  if (state === "preparing") {
    return { activity: `Preparing ${toolCall.name} (${elapsedSeconds ?? 0}s)` };
  }
  if (state === "running") {
    return {
      activity: `${runningActivity} (${elapsedSeconds ?? 0}s)`,
      hint: "Esc to abort",
      target,
    };
  }
  if (state === "failed") return { activity: `Failed to ${action}`, target };

  return { activity: text.doneTitle.replace(` ${target}`, ""), target };
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
  detail: ToolOutputDetail = "compact",
  width: number,
): string[] {
  const sanitizedResult = sanitizeToolOutput(result);

  if (!sanitizedResult || typeof sanitizedResult !== "object") {
    return renderText(
      sanitizedResult === undefined ? "" : String(sanitizedResult),
      width,
      tuiTheme.toolOutput,
    );
  }

  if (isError) {
    return renderText(formatErrorOutput(sanitizedResult), width, tuiTheme.error);
  }

  const sanitizedToolCall = sanitizeToolCallOutput(toolCall);

  switch (toolCall.name) {
    case "read":
      return renderText(formatReadOutput(sanitizedResult), width, tuiTheme.toolOutput);
    case "write":
      return formatWriteOutput(sanitizedToolCall, sanitizedResult, detail, width);
    case "edit":
      return formatEditOutput(sanitizedResult);
    case "bash":
      return renderText(formatBashOutput(sanitizedResult, detail), width, tuiTheme.toolOutput);
    case "remember":
    case "schedule_wake":
      return [];
  }

  return renderText(JSON.stringify(sanitizedResult, null, 2), width, tuiTheme.toolOutput);
}

function renderText(text: string, width: number, textColor: Parameters<typeof color>[1]): string[] {
  return text ? wrapPlainText(text, width).map((line) => color(line, textColor)) : [];
}

export function hasExpandableToolOutput(
  toolCall: ToolCallContent,
  result: unknown,
  isError: boolean,
): boolean {
  if (isError || !result || typeof result !== "object") {
    return false;
  }

  switch (toolCall.name) {
    case "read":
      return hasExpandableReadOutput();
    case "write":
      return hasExpandableWriteOutput(toolCall);
    case "bash":
      return hasExpandableBashOutput(result);
  }

  return false;
}

function toolTarget(toolCall: ToolCallContent, result?: unknown): string {
  if (toolCall.name === "remember") {
    return (
      getStringProperty(result, "scope") ?? getStringProperty(toolCall.args, "scope") ?? "project"
    );
  }

  if (toolCall.name === "schedule_wake") {
    const afterMinutes = getNumberProperty(toolCall.args, "afterMinutes");

    if (afterMinutes !== undefined) {
      return `in ${afterMinutes} ${afterMinutes === 1 ? "minute" : "minutes"}`;
    }
  }

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

function sanitizeToolCallOutput(toolCall: ToolCallContent): ToolCallContent {
  return {
    ...toolCall,
    args: sanitizeToolOutput(toolCall.args),
  };
}

function sanitizeToolOutput(value: unknown): unknown {
  if (typeof value === "string") {
    return stripTerminalControlSequences(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeToolOutput);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeToolOutput(entry)]),
  );
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
    case "remember":
      return {
        action: "save memory",
        approvalTitle: "Allow agent to save memory?",
        doneTitle: `Saved ${target} memory`,
        runningActivity: `saving ${target} memory`,
      };
    case "schedule_wake":
      return {
        action: "schedule wake",
        approvalTitle: "Allow agent to schedule a wake?",
        doneTitle: `Scheduled wake ${target}`,
        runningActivity: `scheduling wake ${target}`,
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
