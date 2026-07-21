import { splitLines, tailLines } from "../../render";
import type { ToolOutputDetail } from "../format";
import { getStringProperty } from "../properties";

const TOOL_OUTPUT_LINE_LIMIT = 8;

export function formatBashOutput(result: object, detail: ToolOutputDetail = "compact"): string {
  const stdout = getStringProperty(result, "stdout");
  const stderr = getStringProperty(result, "stderr");
  const output = joinOutputStreams(stdout, stderr);

  return formatOutputText(output, detail);
}

function formatOutputText(value: string, detail: ToolOutputDetail): string {
  return detail === "full" ? value.trimEnd() : tailLines(value, TOOL_OUTPUT_LINE_LIMIT);
}

export function hasExpandableBashOutput(result: object): boolean {
  const stdout = getStringProperty(result, "stdout");
  const stderr = getStringProperty(result, "stderr");

  return isOutputTextExpandable(joinOutputStreams(stdout, stderr));
}

function joinOutputStreams(stdout: string | undefined, stderr: string | undefined): string {
  if (!stdout) {
    return stderr ?? "";
  }

  if (!stderr) {
    return stdout;
  }

  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

function isOutputTextExpandable(value: string): boolean {
  return splitLines(value.trimEnd()).length > TOOL_OUTPUT_LINE_LIMIT;
}
