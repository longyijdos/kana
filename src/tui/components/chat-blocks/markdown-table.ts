import { type Color, color, truncateToWidth, visibleWidth } from "../../render";
import { tuiTheme } from "../../theme";
import {
  type InlineSpan,
  parseInline,
  resolveInlineLinks,
  styleSpans,
  wrapSpans,
} from "./markdown-inline";

type TableAlignment = "left" | "center" | "right";

type MarkdownTableRow = {
  cells: string[];
  pending: boolean;
  previewCells: string[];
};

export type MarkdownTable = {
  alignments: TableAlignment[];
  header: string[];
  rows: MarkdownTableRow[];
};

export type ParsedMarkdownTable = {
  nextLine: number;
  table: MarkdownTable;
};

type RenderTableOptions = {
  color?: Color;
  hyperlinks?: boolean;
  renderLatex?: boolean;
};

type TableCell = {
  spans: InlineSpan[];
  width: number;
};

const CELL_PADDING = 1;
const COLUMN_GAP = 2;
const MIN_COLUMN_WIDTH = 3;
const HEADER_SEPARATOR = "━";
const BODY_SEPARATOR = "─";

export function parseMarkdownTable(
  lines: string[],
  startLine: number,
  lastLineComplete: boolean,
): ParsedMarkdownTable | undefined {
  const headerLine = lines[startLine];
  const delimiterLine = lines[startLine + 1];

  // Most Markdown lines are not table candidates. Keep the common path to two
  // cheap substring checks before doing any cell-level parsing.
  if (
    headerLine === undefined ||
    delimiterLine === undefined ||
    !headerLine.includes("|") ||
    !delimiterLine.includes("-")
  ) {
    return undefined;
  }

  const header = splitTableRow(headerLine);
  const delimiter = splitTableRow(delimiterLine);

  if (
    !header?.hasPipe ||
    !delimiter?.hasPipe ||
    header.cells.length !== delimiter.cells.length ||
    delimiter.cells.length === 0
  ) {
    return undefined;
  }

  const alignments = delimiter.cells.map(parseDelimiterCell);
  if (alignments.some((alignment) => alignment === undefined)) {
    return undefined;
  }

  const rows: MarkdownTableRow[] = [];
  let nextLine = startLine + 2;

  while (nextLine < lines.length) {
    const rawLine = lines[nextLine] ?? "";
    if (!rawLine.trim()) {
      break;
    }

    const parsed = splitTableRow(rawLine);
    if (!parsed?.hasPipe || parsed.cells.length > header.cells.length) {
      break;
    }

    const previewCells = [...parsed.cells];
    const cells = [...parsed.cells];
    while (cells.length < header.cells.length) {
      cells.push("");
    }

    rows.push({
      cells,
      pending: nextLine === lines.length - 1 && !lastLineComplete,
      previewCells,
    });
    nextLine += 1;
  }

  return {
    nextLine,
    table: {
      alignments: alignments as TableAlignment[],
      header: header.cells,
      rows,
    },
  };
}

export function renderMarkdownTable(
  table: MarkdownTable,
  width: number,
  options: RenderTableOptions = {},
): string[] {
  const safeWidth = Math.max(1, width);
  const hyperlinks = options.hyperlinks === true;
  const renderLatex = options.renderLatex !== false;
  const header = table.header.map((value) => createCell(value, hyperlinks, renderLatex));
  const rows = table.rows.map((row) => ({
    cells: row.cells.map((value) => createCell(value, hyperlinks, renderLatex)),
    pending: row.pending,
    preview: createPreviewCell(row.previewCells, hyperlinks, renderLatex),
  }));
  const committedRows = rows.filter((row) => !row.pending);
  const pendingRows = rows.filter((row) => row.pending);
  const naturalWidths = header.map((cell) => Math.max(MIN_COLUMN_WIDTH, cell.width));
  for (const row of committedRows) {
    for (let column = 0; column < naturalWidths.length; column += 1) {
      naturalWidths[column] = Math.max(
        naturalWidths[column] ?? MIN_COLUMN_WIDTH,
        row.cells[column]?.width ?? 0,
      );
    }
  }
  const contentBudget = safeWidth - tableOverhead(header.length);
  const columnWidths = fitColumnWidths(naturalWidths, contentBudget);

  if (!columnWidths) {
    return [
      ...renderTableRecords(header, committedRows, safeWidth, options),
      ...pendingRows.flatMap((row) => renderPendingRow(row.preview, safeWidth, options)),
    ];
  }

  const lines = [
    ...renderGridRow(header, columnWidths, table.alignments, {
      color: options.color ?? tuiTheme.markdownTable,
      forceBold: true,
    }),
    renderSeparator(columnWidths, HEADER_SEPARATOR),
  ];

  for (const [index, row] of committedRows.entries()) {
    lines.push(
      ...renderGridRow(row.cells, columnWidths, table.alignments, {
        color: options.color ?? tuiTheme.markdownTable,
      }),
    );
    if (index + 1 < committedRows.length) {
      lines.push(renderSeparator(columnWidths, BODY_SEPARATOR));
    }
  }

  lines.push(...pendingRows.flatMap((row) => renderPendingRow(row.preview, safeWidth, options)));

  return lines;
}

function splitTableRow(value: string): { cells: string[]; hasPipe: boolean } | undefined {
  const input = value.trim();
  if (!input) {
    return undefined;
  }

  const cells: string[] = [];
  let cell = "";
  let codeDelimiterLength = 0;
  let hasPipe = false;
  let leadingBoundary = false;
  let trailingBoundary = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";

    if (character === "\\" && input[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }

    if (character === "`") {
      let runLength = 1;
      while (input[index + runLength] === "`") {
        runLength += 1;
      }
      cell += "`".repeat(runLength);
      if (codeDelimiterLength === 0) {
        codeDelimiterLength = runLength;
      } else if (codeDelimiterLength === runLength) {
        codeDelimiterLength = 0;
      }
      index += runLength - 1;
      continue;
    }

    if (character === "|" && codeDelimiterLength === 0) {
      cells.push(cell.trim());
      cell = "";
      hasPipe = true;
      leadingBoundary ||= index === 0;
      trailingBoundary = index === input.length - 1;
      continue;
    }

    trailingBoundary = false;
    cell += character;
  }

  cells.push(cell.trim());

  if (leadingBoundary) {
    cells.shift();
  }
  if (trailingBoundary) {
    cells.pop();
  }

  return { cells, hasPipe };
}

function parseDelimiterCell(value: string): TableAlignment | undefined {
  const delimiter = value.trim();
  if (!/^:?-+:?$/.test(delimiter)) {
    return undefined;
  }

  if (delimiter.startsWith(":") && delimiter.endsWith(":")) {
    return "center";
  }
  if (delimiter.endsWith(":")) {
    return "right";
  }
  return "left";
}

function createCell(value: string, hyperlinks: boolean, renderLatex: boolean): TableCell {
  return createCellFromSpans(resolveInlineLinks(parseInline(value, { renderLatex }), hyperlinks));
}

function createPreviewCell(values: string[], hyperlinks: boolean, renderLatex: boolean): TableCell {
  const spans: InlineSpan[] = [];

  for (const [index, value] of values.entries()) {
    if (index > 0) {
      spans.push({ text: " | " });
    }
    spans.push(...parseInline(value, { renderLatex }));
  }

  return createCellFromSpans(resolveInlineLinks(spans, hyperlinks));
}

function createCellFromSpans(spans: InlineSpan[]): TableCell {
  return {
    spans,
    width: spans.reduce((sum, span) => sum + visibleWidth(span.text), 0),
  };
}

function tableOverhead(columnCount: number): number {
  return columnCount * CELL_PADDING * 2 + Math.max(0, columnCount - 1) * COLUMN_GAP;
}

function fitColumnWidths(naturalWidths: number[], contentBudget: number): number[] | undefined {
  if (naturalWidths.length === 0 || contentBudget < naturalWidths.length * MIN_COLUMN_WIDTH) {
    return undefined;
  }

  const naturalTotal = naturalWidths.reduce((sum, value) => sum + value, 0);
  if (naturalTotal <= contentBudget) {
    return naturalWidths;
  }

  let lower = MIN_COLUMN_WIDTH;
  let upper = Math.max(...naturalWidths);

  // Find the largest shared cap that fits. This avoids shrinking one character
  // at a time when a streamed table contains a very long path or token.
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const total = naturalWidths.reduce((sum, value) => sum + Math.min(value, candidate), 0);

    if (total <= contentBudget) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }

  const widths = naturalWidths.map((value) => Math.min(value, lower));
  let remaining = contentBudget - widths.reduce((sum, value) => sum + value, 0);

  for (let index = 0; index < widths.length && remaining > 0; index += 1) {
    if ((widths[index] ?? 0) < (naturalWidths[index] ?? 0)) {
      widths[index] = (widths[index] ?? 0) + 1;
      remaining -= 1;
    }
  }

  return widths;
}

function renderGridRow(
  cells: TableCell[],
  columnWidths: number[],
  alignments: TableAlignment[],
  options: { color: Color; forceBold?: boolean },
): string[] {
  const wrappedCells = cells.map((cell, index) => {
    const columnWidth = columnWidths[index] ?? MIN_COLUMN_WIDTH;
    return wrapSpans(cell.spans, columnWidth, columnWidth);
  });
  const rowHeight = Math.max(1, ...wrappedCells.map((lines) => lines.length));
  const rowWidth = columnWidthsTotal(columnWidths);
  const rendered: string[] = [];

  for (let rowLine = 0; rowLine < rowHeight; rowLine += 1) {
    let line = "";

    for (let column = 0; column < columnWidths.length; column += 1) {
      const columnWidth = columnWidths[column] ?? MIN_COLUMN_WIDTH;
      const spans = wrappedCells[column]?.[rowLine] ?? [];
      const content = styleSpans(spans, {
        defaultColor: options.color,
        forceBold: options.forceBold,
      });
      const contentWidth = spans.reduce((sum, span) => sum + visibleWidth(span.text), 0);
      const remaining = Math.max(0, columnWidth - contentWidth);
      const [left, right] = alignmentPadding(alignments[column] ?? "left", remaining);
      const isLast = column === columnWidths.length - 1;

      line += `${" ".repeat(CELL_PADDING + left)}${content}`;
      if (!isLast) {
        line += " ".repeat(right + CELL_PADDING + COLUMN_GAP);
      }
    }

    rendered.push(truncateToWidth(line, rowWidth, ""));
  }

  return rendered;
}

function alignmentPadding(alignment: TableAlignment, remaining: number): [number, number] {
  if (alignment === "right") {
    return [remaining, 0];
  }
  if (alignment === "center") {
    const left = Math.floor(remaining / 2);
    return [left, remaining - left];
  }
  return [0, remaining];
}

function columnWidthsTotal(columnWidths: number[]): number {
  return columnWidths.reduce((sum, value) => sum + value, 0) + tableOverhead(columnWidths.length);
}

function renderSeparator(columnWidths: number[], character: string): string {
  const separator = columnWidths
    .map((width) => character.repeat(width + CELL_PADDING * 2))
    .join(" ".repeat(COLUMN_GAP));

  return color(separator, tuiTheme.markdownRule);
}

function renderTableRecords(
  header: TableCell[],
  rows: Array<{ cells: TableCell[] }>,
  width: number,
  options: RenderTableOptions,
): string[] {
  if (rows.length === 0) {
    return header.flatMap((cell) => renderRecordCell(cell, width, " ", options, true));
  }

  const rendered: string[] = [];

  for (const [rowIndex, row] of rows.entries()) {
    for (let column = 0; column < header.length; column += 1) {
      rendered.push(...renderRecordCell(header[column]!, width, " ", options, true));
      rendered.push(...renderRecordCell(row.cells[column]!, width, "  ", options, false));
    }
    if (rowIndex + 1 < rows.length) {
      rendered.push(color(BODY_SEPARATOR.repeat(width), tuiTheme.markdownRule));
    }
  }

  return rendered;
}

function renderPendingRow(
  preview: TableCell,
  width: number,
  options: RenderTableOptions,
): string[] {
  const wrapped = wrapSpans(preview.spans, width, width);

  return wrapped.map((line) =>
    truncateToWidth(
      styleSpans(line, {
        defaultColor: options.color ?? tuiTheme.markdownTable,
      }),
      width,
      "",
    ),
  );
}

function renderRecordCell(
  cell: TableCell,
  width: number,
  prefix: string,
  options: RenderTableOptions,
  forceBold: boolean,
): string[] {
  const prefixWidth = visibleWidth(prefix);
  const contentWidth = Math.max(1, width - prefixWidth);
  const wrapped = wrapSpans(cell.spans, contentWidth, contentWidth);

  return wrapped.map((line) =>
    truncateToWidth(
      `${prefix}${styleSpans(line, {
        defaultColor: options.color ?? tuiTheme.markdownTable,
        forceBold,
      })}`,
      width,
      "",
    ),
  );
}
