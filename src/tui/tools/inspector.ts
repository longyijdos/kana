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

// Composes a tool inspector body for the scrollable viewer: operation
// context first (reusing the full-fidelity detail sections), non-terminal
// status, then the execution output through the existing full renderers.
// Write content and edit old/new text are duplicated into the plain context
// only while the rich renderers below cannot present them (running,
// canceled, or failed tools, where output is missing or error-only);
// completed tools show their material once through the output renderers.
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

// The full renderers recover material payloads from different places:
// formatWriteOutput re-renders content from the tool arguments, while
// formatEditOutput only renders old/new text when the result itself carries
// the complete values. Material stays in the context whenever the renderers
// below would not present it, so running/canceled/failed tools never lose
// their operation payload even when output is missing or error-only.
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
