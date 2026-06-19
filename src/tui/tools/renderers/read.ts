import { splitLines, tailLines } from "../../render";
import type { ToolOutputDetail } from "../format";
import { getNumberProperty, getStringProperty } from "../properties";

const TOOL_OUTPUT_LINE_LIMIT = 8;

export function formatReadOutput(result: object, detail: ToolOutputDetail = "compact"): string {
  const path = getStringProperty(result, "path");
  const content = getStringProperty(result, "content");
  const startLine = getNumberProperty(result, "startLine");
  const endLine = getNumberProperty(result, "endLine");
  const totalLines = getNumberProperty(result, "totalLines");
  const header =
    path && startLine !== undefined && endLine !== undefined && totalLines !== undefined
      ? `${path}:${startLine}-${endLine} of ${totalLines}`
      : path;

  return [header, content ? formatOutputText(content, detail) : undefined]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatOutputText(value: string, detail: ToolOutputDetail): string {
  return detail === "full" ? value.trimEnd() : tailLines(value, TOOL_OUTPUT_LINE_LIMIT);
}

export function hasExpandableReadOutput(result: object): boolean {
  const content = getStringProperty(result, "content");

  return content !== undefined && splitLines(content.trimEnd()).length > TOOL_OUTPUT_LINE_LIMIT;
}
