import type { ToolCallContent } from "@/core";
import {
  color,
  graphemeSegments,
  renderHighlightedLine,
  splitLines,
  tailLines,
  visibleWidth,
} from "../../render";
import { tuiTheme } from "../../theme";
import { highlightCodeSync, inferCodeLanguage } from "../../utils/syntax-highlighter";
import type { ToolOutputDetail } from "../format";
import { getNumberProperty, getStringProperty } from "../properties";

const TOOL_OUTPUT_LINE_LIMIT = 8;

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

  const source = formatOutputText(content, detail);
  const language = inferCodeLanguage(getStringProperty(toolCall.args, "path"));
  const highlighted = highlightCodeSync(source, language);
  const lines = header ? [header] : [];

  for (const tokens of highlighted ?? splitLines(source).map((text) => [{ text }])) {
    for (const wrapped of wrapTokens(tokens, Math.max(1, width - 2))) {
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

function formatOutputText(value: string, detail: ToolOutputDetail): string {
  return detail === "full" ? value.trimEnd() : tailLines(value, TOOL_OUTPUT_LINE_LIMIT);
}

export function hasExpandableWriteOutput(toolCall: ToolCallContent): boolean {
  const content = getStringProperty(toolCall.args, "content");

  return content !== undefined && splitLines(content.trimEnd()).length > TOOL_OUTPUT_LINE_LIMIT;
}

function wrapTokens(
  tokens: Array<{ text: string; color?: string }>,
  width: number,
): Array<Array<{ text: string; color?: string }>> {
  const lines: Array<Array<{ text: string; color?: string }>> = [];
  let line: Array<{ text: string; color?: string }> = [];
  let lineWidth = 0;

  for (const token of tokens) {
    for (const { segment } of graphemeSegments(token.text.replace(/\t/g, "   "))) {
      const segmentWidth = visibleWidth(segment);
      if (line.length > 0 && lineWidth + segmentWidth > width) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }

      const last = line.at(-1);
      if (last && last.color === token.color) last.text += segment;
      else line.push({ text: segment, color: token.color });
      lineWidth += segmentWidth;
    }
  }

  lines.push(line);
  return lines;
}
