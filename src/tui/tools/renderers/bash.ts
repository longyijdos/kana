import { getNumberProperty, getStringProperty } from "../properties";
import { tailLines } from "../../render";

const TOOL_OUTPUT_LINE_LIMIT = 8;

export function formatBashOutput(result: object): string {
  const exitCode = getNumberProperty(result, "exitCode");
  const stdout = getStringProperty(result, "stdout");
  const stderr = getStringProperty(result, "stderr");

  return [
    exitCode === undefined ? undefined : `exit ${exitCode}`,
    stdout ? `stdout:\n${tailLines(stdout, TOOL_OUTPUT_LINE_LIMIT)}` : undefined,
    stderr ? `stderr:\n${tailLines(stderr, TOOL_OUTPUT_LINE_LIMIT)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
