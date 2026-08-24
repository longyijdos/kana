import type { ToolCallContent } from "@/core";
import { splitLines, wrapPlainText } from "../render";
import { buildToolInspectorContext, formatFullToolDetail, isBuiltInToolName } from "./detail";
import { formatToolOutput, type ToolState } from "./format";
import { getStringProperty } from "./properties";

const CONTENT_INDENT = "  ";

const TOOL_STATUS_LABELS: Record<ToolState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

// Context precedes non-terminal status and full output. Write/edit payloads stay in
// context only when rich output cannot show them, avoiding both loss and duplication.
export function formatToolInspector(
  toolCall: ToolCallContent,
  result: unknown,
  isError: boolean,
  state: ToolState,
  width: number,
): string[] {
  const sections = buildToolInspectorContext(toolCall, includeMaterial(toolCall, result, state));
  const lines: string[] = [];

  if (sections.length > 0) {
    lines.push(...renderContextSections(formatFullToolDetail({ title: "", sections }), width));
  }

  if (state !== "done") {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Status");
    lines.push(`${CONTENT_INDENT}${TOOL_STATUS_LABELS[state]}`);
  }

  // Full output rows already soft-wrap to the viewer content width.
  const output = formatToolOutput(toolCall, result, isError, "full", width);

  if (output.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(isBuiltInToolName(toolCall.name) ? "Output" : "Result");
    lines.push(...output);
  }

  return lines;
}

// Write output comes from arguments; edit old/new text comes from successful results.
// Keep material in context whenever those renderers cannot show it.
function includeMaterial(toolCall: ToolCallContent, result: unknown, state: ToolState): boolean {
  if (state !== "done") {
    return true;
  }

  if (toolCall.name === "edit") {
    return (
      getStringProperty(result, "oldText") === undefined ||
      getStringProperty(result, "newText") === undefined
    );
  }

  // A done write always reaches the write renderer, which re-renders the
  // content from args; only a missing or non-object result falls through to
  // the generic plain-text output and would hide it.
  if (toolCall.name === "write" && (result === null || typeof result !== "object")) {
    return true;
  }

  return false;
}

// Indented detail rows soft-wrap to the content width; continuation rows
// keep the section indent so a long command/path stays fully recoverable
// instead of being truncated by the viewer.
function renderContextSections(context: string, width: number): string[] {
  const lines: string[] = [];

  for (const row of splitLines(context)) {
    if (!row.startsWith(CONTENT_INDENT)) {
      lines.push(row);
      continue;
    }

    const content = row.slice(CONTENT_INDENT.length);

    for (const wrapped of wrapPlainText(content, Math.max(1, width - CONTENT_INDENT.length))) {
      lines.push(wrapped === "" ? "" : `${CONTENT_INDENT}${wrapped}`);
    }
  }

  return lines;
}
