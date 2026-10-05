import type { CodemodeResult } from "@earendil-works/pi-codemode";
import type { ToolDetailSection } from "../detail";
import { getBooleanProperty } from "../properties";

export function isRunCodeResult(result: unknown): result is CodemodeResult {
  return getBooleanProperty(result, "ok") !== undefined;
}

export function formatRunCodeOutput(result: CodemodeResult): string {
  const output = textOutput(result);
  const value = result.ok
    ? result.value === undefined
      ? ""
      : JSON.stringify(result.value, null, 2)
    : result.error.message;
  return [output, value].filter(Boolean).join("\n");
}

export function buildRunCodeResultSections(result: CodemodeResult): ToolDetailSection[] {
  const sections: ToolDetailSection[] = [];
  const output = textOutput(result);
  if (output) sections.push({ label: "Output", content: output });
  if (result.ok) {
    if (result.value !== undefined) {
      sections.push({ label: "Return value", content: JSON.stringify(result.value, null, 2) });
    }
  } else {
    sections.push({ label: "Error", content: result.error.stack ?? result.error.message });
  }
  if (result.calls.length > 0) {
    sections.push({
      label: "Tool calls",
      content: result.calls
        .map((call) => `${call.name} · ${call.status} · ${Math.round(call.durationMs)} ms`)
        .join("\n"),
    });
  }
  return sections;
}

function textOutput(result: CodemodeResult): string {
  return result.output
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
