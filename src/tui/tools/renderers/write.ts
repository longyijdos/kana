import type { ToolCallContent } from "@/core";
import {
  color,
  renderHighlightedLine,
  splitLines,
  tailLines,
  truncateToWidth,
  wrapHighlightedLine,
} from "../../render";
import { tuiTheme } from "../../theme";
import { highlightCodeSync, inferCodeLanguage } from "../../utils/syntax-highlighter";
import { COMPACT_WRITE_LINE_LIMIT } from "../compact";
import type { ToolOutputDetail } from "../format";
import { getNumberProperty, getStringProperty } from "../properties";

export function formatWriteOutput(
  toolCall: ToolCallContent,
  result: object,
  detail: ToolOutputDetail = "compact",
  width: number,
): string[] {
  const content = getStringProperty(toolCall.args, "content");
  const bytesWritten = getNumberProperty(result, "bytesWritten");
  const header =
    bytesWritten === undefined ? undefined : color(`${bytesWritten} bytes`, tuiTheme.toolOutput);

  if (!content) return header ? [header] : [];

  // Bound the source before highlighting so a compact preview never pays for
  // highlighting or wrapping megabytes of content it then discards. Compact
  // rows are truncated horizontally instead of wrapped.
  const source = detail === "full" ? content.trimEnd() : truncateCompactSource(content, width);
  const language = inferCodeLanguage(getStringProperty(toolCall.args, "path"));
  const highlighted = highlightCodeSync(source, language);
  const lines = header ? [header] : [];

  for (const tokens of highlighted ?? splitLines(source).map((text) => [{ text }])) {
    if (detail === "compact") {
      lines.push(
        renderHighlightedLine(tokens, {
          prefix: "+ ",
          background: tuiTheme.diffInsertBackground,
          clearToEnd: true,
        }),
      );
      continue;
    }

    for (const wrapped of wrapHighlightedLine(tokens, Math.max(1, width - 2))) {
      lines.push(
        renderHighlightedLine(wrapped, {
          prefix: "+ ",
          background: tuiTheme.diffInsertBackground,
          clearToEnd: true,
        }),
      );
    }
  }

  return lines;
}

function truncateCompactSource(content: string, width: number): string {
  const contentWidth = Math.max(1, width - 2);

  return splitLines(tailLines(content, COMPACT_WRITE_LINE_LIMIT))
    .map((line) => truncateToWidth(line, contentWidth))
    .join("\n");
}
