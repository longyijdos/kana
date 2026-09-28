import { type Color, color, splitLines, tailLines, truncateToWidth, visibleWidth } from "../render";

/** Shared preview budgets keep compact tool-block height independent of terminal width. */
// Default preview budget for shell and generic/MCP/primitive results.
const COMPACT_OUTPUT_LINE_LIMIT = 8;
// Write reserves one row for the `N bytes` result line, so its content
// budget is one row smaller than the shared output limit.
export const COMPACT_WRITE_LINE_LIMIT = 7;
// Edit reserves one row for the replacement count. When the flattened diff
// exceeds this budget, one more row reports the omitted tail.
export const COMPACT_EDIT_LINE_LIMIT = 7;

/**
 * Truncates each of at most `maxLines` source rows and marks omitted rows.
 */
export function renderCompactText(
  text: string,
  width: number,
  textColor: Color,
  keep: "head" | "tail" = "head",
  maxLines: number = COMPACT_OUTPUT_LINE_LIMIT,
): string[] {
  if (!text) {
    return [];
  }

  const trimmed = text.trimEnd();
  const source = keep === "tail" ? tailLines(trimmed, maxLines) : headLines(trimmed, maxLines);

  return splitLines(source).map((line) => color(truncateToWidth(line, width), textColor));
}

/**
 * Reports vertical or known horizontal truncation in a compact preview.
 */
export function hasOmittedContent(
  text: string,
  width: number | undefined,
  maxLines: number = COMPACT_OUTPUT_LINE_LIMIT,
): boolean {
  const lines = splitLines(text.trimEnd());

  if (lines.length > maxLines) {
    return true;
  }

  if (width === undefined) {
    return false;
  }

  return lines.some((line) => visibleWidth(line) > width);
}

function headLines(value: string, limit: number): string {
  const lines = splitLines(value);
  const visible = lines.slice(0, limit);
  const hidden = lines.length - visible.length;

  return hidden > 0 ? `${visible.join("\n")}\n... ${hidden} more lines` : visible.join("\n");
}
