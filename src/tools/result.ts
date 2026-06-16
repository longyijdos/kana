import type { ToolResult } from "./tool";

export function normalizeToolResult(value: unknown): ToolResult {
  if (isToolResult(value)) {
    return value;
  }

  return {
    content: stringifyToolContent(value),
    result: value,
  };
}

export function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string" &&
    "result" in value
  );
}

function stringifyToolContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}
