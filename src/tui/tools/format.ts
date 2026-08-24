import { isToolResultArtifact, type ToolCallContent, type ToolResultArtifact } from "@/core";
import {
  capitalize,
  color,
  stripTerminalControlSequences,
  truncateToWidth,
  wrapPlainText,
} from "../render";
import { tuiTheme } from "../theme";
import {
  COMPACT_DIFF_LINE_LIMIT,
  COMPACT_WRITE_LINE_LIMIT,
  hasOmittedContent,
  renderCompactText,
} from "./compact";
import {
  buildFullToolDetail,
  formatFullToolDetail,
  sanitizeToolDetailLabel,
  sanitizeToolOutput,
  type ToolApprovalSource,
} from "./detail";
import { getBooleanProperty, getNumberProperty, getStringProperty } from "./properties";
import { formatBashOutput } from "./renderers/bash";
import { formatEditOutput } from "./renderers/edit";
import { formatGlobOutput } from "./renderers/glob";
import { formatGrepOutput } from "./renderers/grep";
import { formatListOutput } from "./renderers/list";
import { formatReadOutput } from "./renderers/read";
import { formatTodoTarget, renderTodoState } from "./renderers/todo-write";
import { formatViewImageOutput } from "./renderers/view-image";
import { formatWriteOutput } from "./renderers/write";

export type ToolState = "running" | "done" | "failed" | "canceled";
export type ToolOutputDetail = "compact" | "full";
export type ToolTranscriptTitle = { activity: string; hint?: string; target?: string };

type ToolApprovalText = {
  title: string;
  detail: string;
};

const overwriteMarker = "[OVERWRITE]";

export function highlightOverwriteMarker(text: string): string {
  return text.replaceAll(overwriteMarker, color(overwriteMarker, tuiTheme.error));
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
      activity: formatStatusActivity(runningActivity, ` (${elapsedSeconds ?? 0}s)`),
      hint: "Esc to abort",
      target,
    };
  }
  if (state === "failed") return { activity: `Failed to ${action}`, target };
  if (state === "canceled") {
    return {
      activity: `Canceled ${target ? text.runningActivity.replace(` ${target}`, "") : text.runningActivity}`,
      target,
    };
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
): ToolApprovalText {
  return {
    // The title stays approval-specific UI wording; the paged detail below
    // reuses the full-fidelity representation so approval never pre-summarizes
    // material data before it reaches the ChoicePrompt viewport.
    title: source?.kind === "mcp" ? "Allow MCP tool?" : formatToolApprovalTitle(toolCall),
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
      return formatEditOutput(sanitizedResult, detail, width);
    case "bash": {
      // Preserve the old tail-style compact preview ("... N more lines").
      const output = formatBashOutput(sanitizedResult);
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
    case "list":
    case "glob":
    case "grep":
    case "read":
    case "view_image":
    case "todo_write":
    case "remember":
    case "schedule_wake":
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

    case "bash":
      return hasOmittedContent(formatBashOutput(result), width);

    case "edit": {
      // Compact diff rows render inside 2-column "- "/"+ " prefixes.
      const contentWidth = width === undefined ? undefined : width - 2;
      const oldText = getStringProperty(result, "oldText");
      const newText = getStringProperty(result, "newText");
      return (
        (oldText !== undefined &&
          hasOmittedContent(oldText, contentWidth, COMPACT_DIFF_LINE_LIMIT)) ||
        (newText !== undefined && hasOmittedContent(newText, contentWidth, COMPACT_DIFF_LINE_LIMIT))
      );
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

    case "glob":
      return (
        getStringProperty(result, "pattern") ??
        getStringProperty(toolCall.args, "pattern") ??
        "glob"
      );

    case "grep":
      return (
        getStringProperty(result, "pattern") ??
        getStringProperty(toolCall.args, "pattern") ??
        "grep"
      );

    case "list":
    case "read":
    case "view_image":
    case "write":
    case "edit": {
      const path = getStringProperty(result, "path") ?? getStringProperty(toolCall.args, "path");

      return path ?? toolCall.name;
    }

    case "bash": {
      const command =
        getStringProperty(result, "command") ?? getStringProperty(toolCall.args, "command");

      return command ?? toolCall.name;
    }

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
      activity: formatStatusActivity("Updating todos", ` (${elapsedSeconds ?? 0}s)`),
      hint: "Esc to abort",
    };
  }
  if (state === "failed") {
    return { activity: "Failed to update todos" };
  }
  if (state === "canceled") {
    return { activity: "Canceled updating todos" };
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

function formatToolApprovalTitle(toolCall: ToolCallContent): string {
  return toolText(toolCall.name, toolCall.name, toolCall.args).approvalTitle;
}

function sanitizeToolCallOutput(toolCall: ToolCallContent): ToolCallContent {
  return {
    ...toolCall,
    args: sanitizeToolOutput(toolCall.args),
  };
}

function toolText(
  toolName: string,
  target: string | undefined,
  args?: unknown,
): {
  action: string;
  approvalTitle: string;
  doneTitle: string;
  runningActivity: string;
} {
  switch (toolName) {
    case "list":
      return {
        action: `list ${target}`,
        approvalTitle: "Allow agent to list directory?",
        doneTitle: `Listed ${target}`,
        runningActivity: `listing ${target}`,
      };
    case "glob":
      return {
        action: `match ${target}`,
        approvalTitle: "Allow agent to find paths?",
        doneTitle: `Matched ${target}`,
        runningActivity: `matching ${target}`,
      };
    case "grep":
      return {
        action: `search ${target}`,
        approvalTitle: "Allow agent to search files?",
        doneTitle: `Searched ${target}`,
        runningActivity: `searching ${target}`,
      };
    case "read":
      return {
        action: `read ${target}`,
        approvalTitle: "Allow agent to read file?",
        doneTitle: `Read ${target}`,
        runningActivity: `reading ${target}`,
      };
    case "view_image":
      return {
        action: `view ${target}`,
        approvalTitle: "Allow agent to view image?",
        doneTitle: `Viewed ${target}`,
        runningActivity: `viewing ${target}`,
      };
    case "write":
      return {
        action: withOverwriteMarker(`create ${target}`, args),
        approvalTitle: withOverwriteMarker("Allow agent to create file?", args),
        doneTitle: withOverwriteMarker(`Created ${target}`, args),
        runningActivity: withOverwriteMarker(`creating ${target}`, args),
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
        // Custom/unknown tool names are model/MCP-provided; only the
        // approval title sanitizes the identity because it renders on a
        // fixed row. Transcript action/done/running wording keeps the raw
        // name so compact rendering stays unchanged.
        approvalTitle: `Allow agent to use ${sanitizeToolDetailLabel(toolName)}?`,
        doneTitle: `Used ${toolName}`,
        runningActivity: `using ${toolName}`,
      };
  }
}

function withOverwriteMarker(text: string, args: unknown): string {
  return getBooleanProperty(args, "overwrite") ? `${text} ${overwriteMarker}` : text;
}

function formatStatusActivity(activity: string, suffix: string): string {
  if (!activity.endsWith(` ${overwriteMarker}`)) {
    return `${activity}${suffix}`;
  }

  return `${activity.slice(0, -overwriteMarker.length - 1)}${suffix} ${overwriteMarker}`;
}
