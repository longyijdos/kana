import { type HighlightedLineToken, normalizeLineEndings } from "../../render";
import { CURSOR_MARKER } from "../../runtime";
import { tuiTheme } from "../../theme";
import { createInputLayout, type InputLayoutLine, moveInputCursorVertically } from "./input-layout";
import {
  createEditorDisplayState,
  createPasteAction,
  displayOffsetToSourceOffset,
  type EditorAction,
  type EditorDisplayState,
  type EditorTextState,
} from "./state";

// Input editing shared by the prompt editor and single-purpose text prompts.

export function createTextInsertAction(text: string): EditorAction | undefined {
  const normalized = normalizeLineEndings(text);
  return normalized ? { type: "insert", text: normalized } : undefined;
}

export function createPasteInsertAction(
  text: string,
  collapseLongPastes: boolean,
): EditorAction | undefined {
  const normalized = normalizeLineEndings(text);
  if (!normalized) return undefined;
  return collapseLongPastes ? createPasteAction(normalized) : { type: "insert", text: normalized };
}

export type InputViewport = {
  readonly columns: number;
  readonly visibleLines: number;
  readonly startLine: number | undefined;
};

// Moves the cursor one wrapped line up or down. Returns undefined at the first
// or last line so callers can fall back to history navigation.
export function moveCursorVertically(
  state: EditorTextState,
  viewport: InputViewport,
  direction: -1 | 1,
): { state: EditorTextState; startLine: number } | undefined {
  const display = createEditorDisplayState(state);
  const layout = createInputLayout({
    value: display.value,
    cursorOffset: display.cursorOffset,
    columns: viewport.columns,
    maxLines: viewport.visibleLines,
    preferredStartLine: viewport.startLine,
  });
  const displayCursorOffset = moveInputCursorVertically({
    value: display.value,
    cursorOffset: display.cursorOffset,
    columns: viewport.columns,
    direction,
  });
  if (displayCursorOffset === undefined) {
    return undefined;
  }
  return {
    state: { ...state, cursorOffset: displayOffsetToSourceOffset(display, displayCursorOffset) },
    startLine: layout.startLine,
  };
}

// Renders one wrapped input line, inserting the cursor marker on the cursor
// line. An empty input shows the placeholder after the cursor.
export function renderInputLine(
  line: InputLayoutLine,
  showCursor: boolean,
  display: EditorDisplayState,
  options: {
    placeholder?: string;
    renderText(text: string, absoluteStart: number): HighlightedLineToken[];
  },
): HighlightedLineToken[] {
  const cursor = { text: CURSOR_MARKER, color: tuiTheme.userMessageText };
  if (!showCursor) {
    return options.renderText(line.text, line.startOffset);
  }
  if (!display.value) {
    return [
      cursor,
      ...(options.placeholder ? [{ text: options.placeholder, color: tuiTheme.muted }] : []),
    ];
  }
  if (display.cursorOffset < line.startOffset || display.cursorOffset > line.endOffset) {
    return options.renderText(line.text, line.startOffset);
  }
  const relativeOffset = display.cursorOffset - line.startOffset;
  return [
    ...options.renderText(line.text.slice(0, relativeOffset), line.startOffset),
    cursor,
    ...options.renderText(line.text.slice(relativeOffset), display.cursorOffset),
  ];
}
