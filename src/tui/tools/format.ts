import { isToolResultArtifact, type ToolCallContent, type ToolResultArtifact } from "@/core";
import {
  capitalize,
  color,
  stripTerminalControlSequences,
  summarizeText,
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
import { getBooleanProperty, getNumberProperty, getStringProperty } from "./properties";
import { formatBashOutput } from "./renderers/bash";
import { formatEditOutput } from "./renderers/edit";
import { formatGlobOutput } from "./renderers/glob";
import { formatGrepOutput } from "./renderers/grep";
import { formatListOutput } from "./renderers/list";
import { formatReadOutput } from "./renderers/read";
import { formatViewImageOutput } from "./renderers/view-image";
import { formatWriteOutput } from "./renderers/write";

export type ToolState = "running" | "done" | "failed" | "canceled";
export type ToolOutputDetail = "compact" | "full";
export type ToolTranscriptTitle = { activity: string; hint?: string; target?: string };

type ToolApprovalText = {
  title: string;
  detail: string;
};

export type ToolApprovalSource = {
  kind: "mcp";
  serverId: string;
  remoteToolName: string;
};

const overwriteMarker = "[OVERWRITE]";

export function highlightOverwriteMarker(text: string): string {
  return text.replaceAll(overwriteMarker, color(overwriteMarker, tuiTheme.error));
}

export function formatToolTitle(
  toolCall: ToolCallContent,
  state: ToolState,
  result: unknown,
): string {
  const target = toolTarget(toolCall, result);
  const text = toolText(toolCall.name, target, toolCall.args);

  if (state === "running") {
    return `${formatStatusActivity(capitalize(text.runningActivity), "...")} (Esc to abort)`;
  }

  if (state === "failed") {
    return `Failed to ${text.action}`;
  }

  if (state === "canceled") {
    return `Canceled ${text.runningActivity}`;
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
  const text = toolText(toolCall.name, target, toolCall.args);
  const action = text.action.replace(` ${target}`, "");
  const runningActivity = capitalize(text.runningActivity.replace(` ${target}`, ""));

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
      activity: `Canceled ${text.runningActivity.replace(` ${target}`, "")}`,
      target,
    };
  }

  return { activity: text.doneTitle.replace(` ${target}`, ""), target };
}

export function formatToolTargetLine(target: string, width: number): string {
  return truncateToWidth(target.replace(/\s+/g, " ").trim(), Math.max(1, width));
}

export function formatToolApproval(
  toolCall: ToolCallContent,
  source?: ToolApprovalSource,
): ToolApprovalText {
  if (source?.kind === "mcp") {
    return formatMcpToolApproval(toolCall, source);
  }

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

function toolTarget(toolCall: ToolCallContent, result?: unknown): string {
  if (toolCall.name === "remember") {
    return (
      getStringProperty(result, "scope") ?? getStringProperty(toolCall.args, "scope") ?? "project"
    );
  }

  if (toolCall.name === "schedule_wake") {
    const afterMinutes = getNumberProperty(toolCall.args, "afterMinutes");
    const message = getStringProperty(toolCall.args, "message");

    if (afterMinutes !== undefined) {
      const delay = `in ${afterMinutes} ${afterMinutes === 1 ? "minute" : "minutes"}`;
      return message ? `${delay}\n${message}` : delay;
    }
  }

  if (toolCall.name === "glob") {
    return (
      getStringProperty(result, "pattern") ?? getStringProperty(toolCall.args, "pattern") ?? "glob"
    );
  }

  if (toolCall.name === "grep") {
    return (
      getStringProperty(result, "pattern") ?? getStringProperty(toolCall.args, "pattern") ?? "grep"
    );
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
  return toolText(toolCall.name, toolCall.name, toolCall.args).approvalTitle;
}

function formatMcpToolApproval(
  toolCall: ToolCallContent,
  source: ToolApprovalSource,
): ToolApprovalText {
  const args = sanitizeToolOutput(toolCall.args ?? {});
  let formattedArgs: string;

  try {
    formattedArgs = JSON.stringify(args, null, 2);
  } catch {
    formattedArgs = String(args);
  }

  return {
    title: "Allow MCP tool?",
    detail: [
      `Server: ${sanitizeApprovalLabel(source.serverId)}`,
      `Tool: ${sanitizeApprovalLabel(source.remoteToolName)}`,
      "Arguments:",
      formattedArgs,
    ].join("\n"),
  };
}

function sanitizeApprovalLabel(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\r\n]+/g, " ");
}

function formatToolDetail(toolCall: ToolCallContent): string {
  const target = toolTarget(toolCall);
  const summary = formatToolSummary(toolCall);

  return summary ? `${target} - ${summary}` : target;
}

function formatToolSummary(toolCall: ToolCallContent): string {
  switch (toolCall.name) {
    case "list": {
      const includeHidden = getBooleanProperty(toolCall.args, "includeHidden");

      return includeHidden === false ? "excluding hidden entries" : "";
    }

    case "glob": {
      const cwd = getStringProperty(toolCall.args, "cwd");
      const type = getStringProperty(toolCall.args, "type");
      const parts = [cwd ? `cwd ${cwd}` : undefined, type ? `type ${type}` : undefined].filter(
        (part): part is string => part !== undefined,
      );

      return parts.join(", ");
    }

    case "grep": {
      const path = getStringProperty(toolCall.args, "path");
      const include = getStringProperty(toolCall.args, "include");
      const literal = getBooleanProperty(toolCall.args, "literal");
      const parts = [
        path ? `path ${path}` : undefined,
        include ? `include ${include}` : undefined,
        literal ? "literal" : undefined,
      ].filter((part): part is string => part !== undefined);

      return parts.join(", ");
    }

    case "read": {
      const startLine = getNumberProperty(toolCall.args, "startLine");
      const endLine = getNumberProperty(toolCall.args, "endLine");

      return startLine !== undefined || endLine !== undefined
        ? `lines ${startLine ?? "start"}-${endLine ?? "end"}`
        : "";
    }

    case "view_image":
      return "";

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
        approvalTitle: `Allow agent to use ${toolName}?`,
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
