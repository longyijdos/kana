import type { ToolCallContent } from "../../../../core/messages";
import {
  getNumberProperty,
  getStringProperty,
  tail,
  TOOL_OUTPUT_LINE_LIMIT,
} from "./shared";

export function formatWriteOutput(
  toolCall: ToolCallContent,
  result: object,
): string {
  const content = getStringProperty(toolCall.args, "content");
  const bytesWritten = getNumberProperty(result, "bytesWritten");

  return [
    bytesWritten === undefined ? undefined : `${bytesWritten} bytes`,
    content ? tail(content, TOOL_OUTPUT_LINE_LIMIT) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
