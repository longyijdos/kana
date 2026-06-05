import stringWidth from "string-width";

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
  const cursor = {
    line: cursorLine - startLine,
    column: Math.min(
      cursorColumn(wrappedLines[cursorLine] ?? wrappedLines[0], cursorOffset),
      layoutColumns,
    ),
  };

  return {
    lines: visibleLines.length > 0 ? visibleLines : [createLine(0)],
    cursor,
    isTruncatedStart: startLine > 0,
  };
}

function wrapInputValue(value: string, columns: number): WrappedLine[] {
  const lines = [createLine(0)];

  if (!value) {
    return lines;
  }

  for (const glyph of graphemeGlyphs(value)) {
    let current = lines.at(-1) ?? createLine(glyph.startOffset);

    if (glyph.text === "\n") {
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

function findCursorLine(lines: WrappedLine[], cursorOffset: number): number {
  for (const [index, line] of lines.entries()) {
    if (index > 0 && cursorOffset === line.startOffset) {
      return index;
    }

    if (cursorOffset >= line.startOffset && cursorOffset <= line.endOffset) {
      return index;
    }
  }

  return Math.max(lines.length - 1, 0);
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
  return graphemeSegments(value).map((segment) => ({
    text: segment.segment,
    startOffset: segment.index,
    endOffset: segment.index + segment.segment.length,
    width: stringWidth(segment.segment),
  }));
}

function graphemeSegments(value: string): Array<{ segment: string; index: number }> {
  const segmenter = getSegmenter();

  if (segmenter) {
    return Array.from(segmenter.segment(value), (segment) => ({
      segment: segment.segment,
      index: segment.index,
    }));
  }

  let index = 0;

  return Array.from(value, (segment) => {
    const current = {
      segment,
      index,
    };
    index += segment.length;

    return current;
  });
}

function getSegmenter():
  | {
      segment(value: string): Iterable<{ segment: string; index: number }>;
    }
  | undefined {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale: string,
        options: { granularity: "grapheme" },
      ) => {
        segment(value: string): Iterable<{ segment: string; index: number }>;
      };
    }
  ).Segmenter;

  return Segmenter
    ? new Segmenter("en", {
        granularity: "grapheme",
      })
    : undefined;
}
