import { background, dim, type Color } from "../../render";
import { splitLines } from "../../render";
import { tuiTheme } from "../../theme";
import { getNumberProperty, getStringProperty } from "../properties";

export function formatEditOutput(result: object): string[] {
  const oldText = getStringProperty(result, "oldText");
  const newText = getStringProperty(result, "newText");
  const replacements = getNumberProperty(result, "replacements");
  const lines: string[] = [];

  if (replacements !== undefined) {
    lines.push(dim(`${replacements} replacement${replacements === 1 ? "" : "s"}`));
  }

  if (oldText !== undefined) {
    lines.push(...formatDiffLines(oldText, "-", tuiTheme.diffDeleteBackground));
  }

  if (newText !== undefined) {
    lines.push(...formatDiffLines(newText, "+", tuiTheme.diffInsertBackground));
  }

  return lines;
}

function formatDiffLines(value: string, marker: "-" | "+", lineBackground: Color): string[] {
  const lines = splitLines(value);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return (lines.length ? lines : [""]).map((line) =>
    background(`${marker} ${line}`, lineBackground),
  );
}
