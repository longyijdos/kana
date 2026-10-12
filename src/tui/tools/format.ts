import { isToolResultArtifact, type ToolCallContent, type ToolResultArtifact } from "@/core";
import {
  capitalize,
  color,
  stripTerminalControlSequences,
  truncateToWidth,
  wrapPlainText,
} from "../render";
import { tuiTheme } from "../theme";
import { COMPACT_WRITE_LINE_LIMIT, hasOmittedContent, renderCompactText } from "./compact";
import {
  buildFullToolDetail,
  formatFullToolDetail,
  sanitizeToolOutput,
  type ToolApprovalSource,
} from "./detail";
import { getNumberProperty, getStringProperty } from "./properties";
import { formatEditOutput, hasExpandableEditOutput } from "./renderers/edit";
import { formatGlobOutput } from "./renderers/glob";
import { formatGrepOutput } from "./renderers/grep";
import { formatListOutput } from "./renderers/list";
import { formatReadOutput } from "./renderers/read";
import { formatRunCodeOutput, isRunCodeResult } from "./renderers/run-code";
import { formatShellOutput } from "./renderers/shell";
import { formatTodoTarget, renderTodoState } from "./renderers/todo-write";
import { formatViewImageOutput } from "./renderers/view-image";
import { formatWriteOutput } from "./renderers/write";
import type { ToolApprovalText, ToolOutputDetail, ToolState, ToolTranscriptTitle } from "./types";
import { backgroundMarker, formatStatusActivity, overwriteMarker, toolText } from "./wording";

export function highlightOverwriteMarker(text: string): string {
  return text
    .replaceAll(overwriteMarker, color(overwriteMarker, tuiTheme.error))
    .replaceAll(backgroundMarker, color(backgroundMarker, tuiTheme.usageWarning));
}

export function formatToolTranscriptTitle(
  toolCall: ToolCallContent,
  state: ToolState,
  result: unknown,
  elapsedSeconds?: number,
): ToolTranscriptTitle {
  if (toolCall.name === "todo_write") {
    return formatTodoTranscriptTitle(state, result, elapsedSeconds);
  }
  const target = resolveToolTarget(toolCall, result);
  const text = toolText(toolCall.name, target, toolCall.args);
  const action = target ? text.action.replace(` ${target}`, "") : text.action;
  const runningActivity = capitalize(
    target ? text.runningActivity.replace(` ${target}`, "") : text.runningActivity,
  );

  if (state === "running") {
    return {
      activity:
        elapsedSeconds === undefined
          ? runningActivity
          : formatStatusActivity(runningActivity, ` (${elapsedSeconds}s)`),
      hint: elapsedSeconds === undefined ? undefined : "Esc to abort",
      target,
    };
  }
  if (state === "failed") return { activity: `Failed to ${action}`, target };
  if (state === "cancelled") {
    return {
      activity: `Cancelled ${target ? text.runningActivity.replace(` ${target}`, "") : text.runningActivity}`,
      target,
    };
  }

  if (toolCall.name === "run_code" && isRunCodeResult(result)) {
    const count = result.calls.length;
    return { activity: `Ran code · ${count} ${count === 1 ? "call" : "calls"}` };
  }
  return { activity: target ? text.doneTitle.replace(` ${target}`, "") : text.doneTitle, target };
}

// Strip terminal controls before collapsing whitespace so schema-owned targets cannot
// inject escapes. The transcript and picker share this untruncated representation.
export function sanitizeToolTargetText(target: string): string {
  return flattenToolTargetText(stripTerminalControlSequences(target));
}

export function formatToolTargetLine(target: string, width: number): string {
  return truncateToWidth(sanitizeToolTargetText(target), Math.max(1, width));
}

// Collapses a possibly multi-line target (e.g. a schedule delay plus its
// message) into one renderable row without truncating it.
function flattenToolTargetText(target: string): string {
  return target.replace(/\s+/g, " ").trim();
}

export function formatToolApproval(
  toolCall: ToolCallContent,
  source?: ToolApprovalSource,
  requesterName = "Kana",
): ToolApprovalText {
  return {
    // The title stays approval-specific UI wording; the paged detail below
    // reuses the full-fidelity representation so approval never pre-summarizes
    // material data before it reaches the ChoicePrompt viewport.
    title:
      source?.kind === "mcp"
        ? `Allow ${requesterName} to use MCP tool?`
        : formatToolApprovalTitle(toolCall, requesterName),
    detail: formatFullToolDetail(buildFullToolDetail(toolCall, source)),
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

  if (isToolResultArtifact(sanitizedResult)) {
    return renderText(
      formatArtifactOutput(sanitizedResult, detail),
      width,
      tuiTheme.toolOutput,
      detail,
    );
  }

  if (!sanitizedResult || typeof sanitizedResult !== "object") {
    return renderText(
      sanitizedResult === undefined ? "" : String(sanitizedResult),
      width,
      tuiTheme.toolOutput,
      detail,
    );
  }

  const error = getStringProperty(sanitizedResult, "error");

  if (isError && error !== undefined) {
    return renderText(error, width, tuiTheme.error, detail);
  }

  const sanitizedToolCall = sanitizeToolCallOutput(toolCall);

  switch (toolCall.name) {
    case "run_code":
      if (isRunCodeResult(sanitizedResult)) {
        return renderText(
          formatRunCodeOutput(sanitizedResult),
          width,
          isError ? tuiTheme.error : tuiTheme.toolOutput,
          detail,
        );
      }
      break;
    case "list":
      return renderText(formatListOutput(sanitizedResult), width, tuiTheme.toolOutput, detail);
    case "glob":
      return renderText(formatGlobOutput(sanitizedResult), width, tuiTheme.toolOutput, detail);
    case "grep":
      return renderText(formatGrepOutput(sanitizedResult), width, tuiTheme.toolOutput, detail);
    case "read":
      return renderText(formatReadOutput(sanitizedResult), width, tuiTheme.toolOutput, detail);
    case "view_image":
      return renderText(formatViewImageOutput(sanitizedResult), width, tuiTheme.toolOutput, detail);
    case "write":
      return formatWriteOutput(sanitizedToolCall, sanitizedResult, detail, width);
    case "edit":
      return formatEditOutput(sanitizedToolCall, sanitizedResult, detail, width);
    case "shell": {
      // Preserve the old tail-style compact preview ("... N more lines").
      const output = formatShellOutput(sanitizedResult);
      return detail === "full"
        ? renderText(output, width, tuiTheme.toolOutput, detail)
        : renderCompactText(output, width, tuiTheme.toolOutput, "tail");
    }
    case "todo_write": {
      const items = getTodoItems(sanitizedResult);
      return items === undefined || detail === "compact" ? [] : renderTodoState(items, width);
    }
    case "remember":
    case "schedule_wake":
    case "update_goal":
      return [];
  }

  return renderText(stringifyToolResult(sanitizedResult), width, tuiTheme.toolOutput, detail);
}

function renderText(
  text: string,
  width: number,
  textColor: Parameters<typeof color>[1],
  detail: ToolOutputDetail,
): string[] {
  if (!text) {
    return [];
  }

  if (detail === "full") {
    return wrapPlainText(text, width).map((line) => color(line, textColor));
  }

  return renderCompactText(text, width, textColor);
}

function stringifyToolResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function hasExpandableToolOutput(
  toolCall: ToolCallContent,
  result: unknown,
  isError: boolean,
  width?: number,
): boolean {
  if (isToolResultArtifact(result)) {
    return true;
  }

  if (!result || typeof result !== "object") {
    return result !== undefined && hasOmittedContent(String(result), width);
  }

  const error = getStringProperty(result, "error");

  if (isError && error !== undefined) {
    return hasOmittedContent(error, width);
  }

  switch (toolCall.name) {
    case "run_code":
      if (isRunCodeResult(result)) {
        return hasOmittedContent(formatRunCodeOutput(result), width);
      }
      break;
    case "list":
    case "glob":
    case "grep":
    case "read":
    case "view_image":
    case "todo_write":
    case "remember":
    case "schedule_wake":
    case "update_goal":
      return false;

    case "write": {
      const content = getStringProperty(toolCall.args, "content");
      // Compact write rows render inside a 2-column "+ " prefix.
      return (
        content !== undefined &&
        hasOmittedContent(
          content,
          width === undefined ? undefined : width - 2,
          COMPACT_WRITE_LINE_LIMIT,
        )
      );
    }

    case "shell":
      return hasOmittedContent(formatShellOutput(result), width);

    case "edit": {
      return hasExpandableEditOutput(toolCall, width);
    }
  }

  // Unknown/custom/MCP tools render a bounded pretty-JSON preview; the
  // complete result stays available through the scrollable viewer.
  return hasOmittedContent(stringifyToolResult(result), width);
}

function formatArtifactOutput(artifact: ToolResultArtifact, detail: ToolOutputDetail): string {
  const summary = `Output stored · ${formatByteSize(artifact.byteLength)}`;
  if (detail === "compact") {
    return summary;
  }
  return [
    summary,
    `Full output locator: ${artifact.locator}`,
    "Use grep with this locator plus pattern to locate text; for line-oriented output, use read with offset and limit.",
  ].join("\n");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${Math.round(bytes / 1_024)} KB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/** Extracts targets only for Kana-owned schemas; unknown tools remain name-only. */
export function resolveToolTarget(toolCall: ToolCallContent, result?: unknown): string | undefined {
  switch (toolCall.name) {
    case "remember":
      return (
        getStringProperty(result, "scope") ?? getStringProperty(toolCall.args, "scope") ?? "project"
      );

    case "schedule_wake": {
      const afterMinutes = getNumberProperty(toolCall.args, "afterMinutes");
      const message = getStringProperty(toolCall.args, "message");

      if (afterMinutes !== undefined) {
        const delay = `in ${afterMinutes} ${afterMinutes === 1 ? "minute" : "minutes"}`;
        return message ? `${delay}\n${message}` : delay;
      }
      return undefined;
    }

    case "update_goal":
      return getStringProperty(toolCall.args, "status");

    case "glob":
    case "grep":
      return getStringProperty(toolCall.args, "pattern") ?? toolCall.name;

    case "list":
    case "read":
    case "view_image":
    case "write":
    case "edit": {
      const path = getStringProperty(result, "path") ?? getStringProperty(toolCall.args, "path");

      return path ?? toolCall.name;
    }

    case "shell":
    case "job_start":
      return getStringProperty(toolCall.args, "command") ?? toolCall.name;

    case "todo_write":
      return formatTodoTarget(getTodoItems(result) ?? []);

    default:
      return undefined;
  }
}

function formatTodoTranscriptTitle(
  state: ToolState,
  result: unknown,
  elapsedSeconds: number | undefined,
): ToolTranscriptTitle {
  const items = getTodoItems(result);
  if (state === "running") {
    return {
      activity:
        elapsedSeconds === undefined
          ? "Updating todos"
          : formatStatusActivity("Updating todos", ` (${elapsedSeconds}s)`),
      hint: elapsedSeconds === undefined ? undefined : "Esc to abort",
    };
  }
  if (state === "failed") {
    return { activity: "Failed to update todos" };
  }
  if (state === "cancelled") {
    return { activity: "Cancelled updating todos" };
  }
  if (items?.length === 0) {
    return { activity: "Cleared todos" };
  }
  return {
    activity: "Updated todos",
    target: items === undefined ? undefined : formatTodoTarget(items),
  };
}

function getTodoItems(
  value: unknown,
): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items)) {
    return undefined;
  }
  const parsed = items.filter(
    (item): item is { content: string; status: "pending" | "in_progress" | "completed" } =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).content === "string" &&
      ((item as Record<string, unknown>).status === "pending" ||
        (item as Record<string, unknown>).status === "in_progress" ||
        (item as Record<string, unknown>).status === "completed"),
  );
  return parsed.length === items.length ? parsed : undefined;
}

function formatToolApprovalTitle(toolCall: ToolCallContent, requesterName: string): string {
  return toolText(toolCall.name, toolCall.name, toolCall.args, requesterName).approvalTitle;
}

function sanitizeToolCallOutput(toolCall: ToolCallContent): ToolCallContent {
  return {
    ...toolCall,
    args: sanitizeToolOutput(toolCall.args),
  };
}
