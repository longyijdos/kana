import {
  type Color,
  dim,
  renderHighlightedLine,
  splitLines,
  tailLines,
  truncateToWidth,
  wrapHighlightedLine,
} from "../../render";
import { tuiTheme } from "../../theme";
import { highlightCodeSync, inferCodeLanguage } from "../../utils/syntax-highlighter";
import { COMPACT_DIFF_LINE_LIMIT } from "../compact";
import { getNumberProperty, getStringProperty } from "../properties";
import type { ToolOutputDetail } from "../types";

export function formatEditOutput(
  result: object,
  detail: ToolOutputDetail,
  width: number,
): string[] {
  const path = getStringProperty(result, "path");
  const oldText = getStringProperty(result, "oldText");
  const newText = getStringProperty(result, "newText");
  const replacements = getNumberProperty(result, "replacements");
  const lines: string[] = [];

  if (replacements !== undefined) {
    lines.push(dim(`${replacements} replacement${replacements === 1 ? "" : "s"}`));
  }

  if (oldText !== undefined) {
    lines.push(
      ...formatDiffLines(oldText, "-", tuiTheme.diffDeleteBackground, path, detail, width),
    );
  }

  if (newText !== undefined) {
    lines.push(
      ...formatDiffLines(newText, "+", tuiTheme.diffInsertBackground, path, detail, width),
    );
  }

  return lines;
}

function formatDiffLines(
  value: string,
  marker: "-" | "+",
  lineBackground: Color,
  path: string | undefined,
  detail: ToolOutputDetail,
  width: number,
): string[] {
  // Bound the source before highlighting so a compact preview never pays for
  // highlighting a huge diff it then discards. Compact rows are truncated
  // horizontally instead of wrapped.
  const source =
    detail === "full"
      ? value.trimEnd()
      : splitLines(tailLines(value, COMPACT_DIFF_LINE_LIMIT))
          .map((line) => truncateToWidth(line, Math.max(1, width - 2)))
          .join("\n");
  const lines = splitLines(source);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  const sourceLines = lines.length ? lines : [""];
  const highlighted = highlightCodeSync(sourceLines.join("\n"), inferCodeLanguage(path));
  const rendered: string[] = [];

  for (const tokens of highlighted ?? sourceLines.map((text) => [{ text }])) {
    if (detail === "compact") {
      rendered.push(
        renderHighlightedLine(tokens, {
          prefix: `${marker} `,
          background: lineBackground,
          clearToEnd: true,
        }),
      );
      continue;
    }

    // Full rows wrap to the viewer content width so overlong diff lines stay
    // readable instead of being truncated again by the viewer.
    for (const wrapped of wrapHighlightedLine(tokens, Math.max(1, width - 2))) {
      rendered.push(
        renderHighlightedLine(wrapped, {
          prefix: `${marker} `,
          background: lineBackground,
          clearToEnd: true,
        }),
      );
    }
  }

  return rendered;
}
