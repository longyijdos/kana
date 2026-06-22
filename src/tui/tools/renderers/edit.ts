import { background, type Color, dim, renderHighlightedLine, splitLines } from "../../render";
import { tuiTheme } from "../../theme";
import { highlightCodeSync, inferCodeLanguage } from "../../utils/syntax-highlighter";
import { getNumberProperty, getStringProperty } from "../properties";

export function formatEditOutput(result: object): string[] {
  const path = getStringProperty(result, "path");
  const oldText = getStringProperty(result, "oldText");
  const newText = getStringProperty(result, "newText");
  const replacements = getNumberProperty(result, "replacements");
  const lines: string[] = [];

  if (replacements !== undefined) {
    lines.push(dim(`${replacements} replacement${replacements === 1 ? "" : "s"}`));
  }

  if (oldText !== undefined) {
    lines.push(...formatDiffLines(oldText, "-", tuiTheme.diffDeleteBackground, path));
  }

  if (newText !== undefined) {
    lines.push(...formatDiffLines(newText, "+", tuiTheme.diffInsertBackground, path));
  }

  return lines;
}

function formatDiffLines(
  value: string,
  marker: "-" | "+",
  lineBackground: Color,
  path: string | undefined,
): string[] {
  const lines = splitLines(value);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  const sourceLines = lines.length ? lines : [""];
  const highlighted = highlightCodeSync(sourceLines.join("\n"), inferCodeLanguage(path));

  if (!highlighted) {
    return sourceLines.map((line) => background(`${marker} ${line}`, lineBackground));
  }

  return highlighted.map((tokens) =>
    renderHighlightedLine(tokens, {
      prefix: `${marker} `,
      background: lineBackground,
      clearToEnd: true,
    }),
  );
}
