import { background, type Color, dim, splitLines } from "../../render";
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

  return highlighted.map(
    (tokens) =>
      `${background(`${marker} `, lineBackground)}${tokens
        .map((token) => background(colorToken(token.text, token.color), lineBackground))
        .join("")}`,
  );
}

function colorToken(text: string, tokenColor: string | undefined): string {
  const hex = tokenColor?.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);

  if (!hex) {
    return text;
  }

  return `\x1b[38;2;${parseInt(hex[1]!, 16)};${parseInt(hex[2]!, 16)};${parseInt(hex[3]!, 16)}m${text}\x1b[0m`;
}
