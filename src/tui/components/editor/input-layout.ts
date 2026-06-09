import { firstGrapheme } from "./state";
import { visibleWidth } from "../../render/width";

export type InputLayoutLine = {
  text: string;
  startOffset: number;
  endOffset: number;
  width: number;
};

export type InputLayoutCursor = {
  line: number;
  column: number;
};

export type InputLayout = {
  lines: InputLayoutLine[];
  cursor: InputLayoutCursor;
  isTruncatedStart: boolean;
};

export type CreateInputLayoutOptions = {
  value: string;
  cursorOffset: number;
  columns: number;
  maxLines: number;
};

export type MoveInputCursorVerticallyOptions = {
  value: string;
  cursorOffset: number;
  columns: number;
  direction: -1 | 1;
};

type WrappedLine = InputLayoutLine & {
  glyphs: Glyph[];
};

type Glyph = {
  text: string;
  startOffset: number;
  endOffset: number;
  width: number;
};

export function createInputLayout({
  value,
  cursorOffset,
  columns,
  maxLines,
}: CreateInputLayoutOptions): InputLayout {
  const layoutColumns = Math.max(columns, 1);
  const layoutMaxLines = Math.max(maxLines, 1);
  const wrappedLines = wrapInputValue(value, layoutColumns);
  const cursorLine = findCursorLine(wrappedLines, cursorOffset);
  const startLine = Math.max(
    0,
    Math.min(
      cursorLine - layoutMaxLines + 1,
      wrappedLines.length - layoutMaxLines,
    ),
  );
  const visibleLines = wrappedLines
    .slice(startLine, startLine + layoutMaxLines)
    .map(({ glyphs, ...line }) => line);

  return {
    lines: visibleLines.length > 0 ? visibleLines : [createLine(0)],
    cursor: {
      line: cursorLine - startLine,
      column: Math.min(
        cursorColumn(wrappedLines[cursorLine] ?? wrappedLines[0], cursorOffset),
        layoutColumns,
      ),
    },
    isTruncatedStart: startLine > 0,
  };
}

export function moveInputCursorVertically({
  value,
  cursorOffset,
  columns,
  direction,
}: MoveInputCursorVerticallyOptions): number | undefined {
  const layoutColumns = Math.max(columns, 1);
  const wrappedLines = wrapInputValue(value, layoutColumns);
  const cursorLine = findCursorLine(wrappedLines, cursorOffset);
  const targetLine = cursorLine + direction;

  if (targetLine < 0 || targetLine >= wrappedLines.length) {
    return undefined;
  }

  const targetColumn = cursorColumn(wrappedLines[cursorLine], cursorOffset);

  return cursorOffsetForColumn(wrappedLines[targetLine], targetColumn);
}

function wrapInputValue(value: string, columns: number): WrappedLine[] {
  const lines = [createLine(0)];

  if (!value) {
    return lines;
  }

  for (const glyph of graphemeGlyphs(value)) {
    let current = lines.at(-1) ?? createLine(glyph.startOffset);

    if (isLineBreak(glyph.text)) {
      current.endOffset = glyph.startOffset;
      lines.push(createLine(glyph.endOffset));
      continue;
    }

    if (current.glyphs.length > 0 && current.width + glyph.width > columns) {
      current = createLine(glyph.startOffset);
      lines.push(current);
    }

    current.glyphs.push(glyph);
    current.text += glyph.text;
    current.width += glyph.width;
    current.endOffset = glyph.endOffset;
  }

  return lines;
}

function createLine(offset: number): WrappedLine {
  return {
    text: "",
    startOffset: offset,
    endOffset: offset,
    width: 0,
    glyphs: [],
  };
}

function isLineBreak(value: string): boolean {
  return value === "\n" || value === "\r" || value === "\r\n";
}

function findCursorLine(lines: WrappedLine[], cursorOffset: number): number {
  for (const [index, line] of lines.entries()) {
    if (index > 0 && cursorOffset === line.startOffset) {
      return index;
    }
  }

  for (const [index, line] of lines.entries()) {
    if (cursorOffset >= line.startOffset && cursorOffset <= line.endOffset) {
      return index;
    }
  }

  return Math.max(lines.length - 1, 0);
}

function cursorOffsetForColumn(line: WrappedLine, targetColumn: number): number {
  let column = 0;

  for (const glyph of line.glyphs) {
    if (column >= targetColumn || column + glyph.width > targetColumn) {
      return glyph.startOffset;
    }

    column += glyph.width;
  }

  return line.endOffset;
}

function cursorColumn(line: WrappedLine | undefined, cursorOffset: number): number {
  if (!line) {
    return 0;
  }

  let column = 0;

  for (const glyph of line.glyphs) {
    if (glyph.startOffset >= cursorOffset) {
      return column;
    }

    if (glyph.endOffset <= cursorOffset) {
      column += glyph.width;
    }
  }

  return column;
}

function graphemeGlyphs(value: string): Glyph[] {
  const glyphs: Glyph[] = [];
  let offset = 0;

  while (offset < value.length) {
    const text = firstGrapheme(value.slice(offset)) ?? value[offset] ?? "";
    glyphs.push({
      text,
      startOffset: offset,
      endOffset: offset + text.length,
      width: visibleWidth(text),
    });
    offset += text.length;
  }

  return glyphs;
}
