import type { ToolCallContent } from "@/core";
import {
  getNumberProperty,
  getStringProperty,
} from "../properties";
import { tailLines } from "../../render";

const TOOL_OUTPUT_LINE_LIMIT = 8;

export function formatWriteOutput(
  toolCall: ToolCallContent,
  result: object,
): string {
  const content = getStringProperty(toolCall.args, "content");
  const bytesWritten = getNumberProperty(result, "bytesWritten");

  return [
    bytesWritten === undefined ? undefined : `${bytesWritten} bytes`,
    content ? tailLines(content, TOOL_OUTPUT_LINE_LIMIT) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
