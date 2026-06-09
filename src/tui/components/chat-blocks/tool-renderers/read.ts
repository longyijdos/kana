import {
  getNumberProperty,
  getStringProperty,
  tail,
  TOOL_OUTPUT_LINE_LIMIT,
} from "./shared";

export function formatReadOutput(result: object): string {
  const path = getStringProperty(result, "path");
  const content = getStringProperty(result, "content");
  const startLine = getNumberProperty(result, "startLine");
  const endLine = getNumberProperty(result, "endLine");
  const totalLines = getNumberProperty(result, "totalLines");
  const header =
    path && startLine !== undefined && endLine !== undefined && totalLines !== undefined
      ? `${path}:${startLine}-${endLine} of ${totalLines}`
      : path;

  return [header, content ? tail(content, TOOL_OUTPUT_LINE_LIMIT) : undefined]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
