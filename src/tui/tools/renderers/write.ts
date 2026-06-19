import type { ToolCallContent } from "@/core";
import { tailLines } from "../../render";
import type { ToolOutputDetail } from "../format";
import { getNumberProperty, getStringProperty } from "../properties";

const TOOL_OUTPUT_LINE_LIMIT = 8;

export function formatWriteOutput(
  toolCall: ToolCallContent,
  result: object,
  detail: ToolOutputDetail = "compact",
): string {
  const content = getStringProperty(toolCall.args, "content");
  const bytesWritten = getNumberProperty(result, "bytesWritten");

  return [
    bytesWritten === undefined ? undefined : `${bytesWritten} bytes`,
    content ? formatOutputText(content, detail) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatOutputText(value: string, detail: ToolOutputDetail): string {
  return detail === "full" ? value.trimEnd() : tailLines(value, TOOL_OUTPUT_LINE_LIMIT);
}
