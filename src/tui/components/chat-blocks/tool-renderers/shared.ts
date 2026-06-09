import type { ToolCallContent } from "../../../../core/messages";

export const TOOL_OUTPUT_LINE_LIMIT = 8;

export function toolTarget(toolCall: ToolCallContent, result?: unknown): string {
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

export function tail(value: string, limit: number): string {
  const lines = value.trimEnd().split("\n");
  const visible = lines.slice(-limit);
  const hidden = lines.length - visible.length;

  return hidden > 0
    ? `... ${hidden} more lines\n${visible.join("\n")}`
    : visible.join("\n");
}

export function getStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "string" ? property : undefined;
}

export function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = value[key as keyof typeof value];

  return typeof property === "number" ? property : undefined;
}
