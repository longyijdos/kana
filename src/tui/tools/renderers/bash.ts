import { getStringProperty } from "../properties";

/**
 * Returns the complete joined stdout/stderr text. Bounding and truncation are
 * applied at the compact-rendering boundary in `format.ts`.
 */
export function formatBashOutput(result: object): string {
  const stdout = getStringProperty(result, "stdout");
  const stderr = getStringProperty(result, "stderr");

  return joinOutputStreams(stdout, stderr).trimEnd();
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
