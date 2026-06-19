import { tailLines } from "../../render";
import type { ToolOutputDetail } from "../format";
import { getNumberProperty, getStringProperty } from "../properties";

const TOOL_OUTPUT_LINE_LIMIT = 8;

export function formatBashOutput(result: object, detail: ToolOutputDetail = "compact"): string {
  const exitCode = getNumberProperty(result, "exitCode");
  const stdout = getStringProperty(result, "stdout");
  const stderr = getStringProperty(result, "stderr");

  return [
    exitCode === undefined ? undefined : `exit ${exitCode}`,
    stdout ? `stdout:\n${formatOutputText(stdout, detail)}` : undefined,
    stderr ? `stderr:\n${formatOutputText(stderr, detail)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatOutputText(value: string, detail: ToolOutputDetail): string {
  return detail === "full" ? value.trimEnd() : tailLines(value, TOOL_OUTPUT_LINE_LIMIT);
}
