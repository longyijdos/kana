import { background, dim, type BackgroundColor } from "../../../render/ansi";
import { splitLines } from "../../../render/lines";
import {
  getNumberProperty,
  getStringProperty,
} from "./shared";

export function formatEditOutput(result: object): string[] {
  const oldText = getStringProperty(result, "oldText");
  const newText = getStringProperty(result, "newText");
  const replacements = getNumberProperty(result, "replacements");
  const lines: string[] = [];

  if (replacements !== undefined) {
    lines.push(dim(`${replacements} replacement${replacements === 1 ? "" : "s"}`));
  }

  if (oldText !== undefined) {
    lines.push(...formatDiffLines(oldText, "-", "diffDelete"));
  }

  if (newText !== undefined) {
    lines.push(...formatDiffLines(newText, "+", "diffInsert"));
  }

  return lines;
}

function formatDiffLines(
  value: string,
  marker: "-" | "+",
  lineBackground: BackgroundColor,
): string[] {
  const lines = splitLines(value);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return (lines.length ? lines : [""]).map((line) =>
    background(`${marker} ${line}`, lineBackground),
  );
}
