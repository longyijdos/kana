import {
  color,
  type HighlightedLineToken,
  normalizeLineEndings,
  padRightAnsi,
  renderHighlightedLine,
  summarizeText,
  truncateToWidth,
  visibleWidth,
} from "../render";
import type { Component } from "../runtime";
import {
  CURSOR_MARKER,
  isBackspace,
  isDelete,
  isDown,
  isEnd,
  isEnter,
  isEscape,
  isHome,
  isLeft,
  isPrintable,
  isRight,
  isShiftEnter,
  isUp,
} from "../runtime";
import { tuiTheme } from "../theme";
import { BracketedPasteBuffer } from "../utils/bracketed-paste";
import { visibleLimitForHeight } from "../utils/list-viewport";
import {
  createInputLayout,
  type InputLayoutLine,
  moveInputCursorVertically,
} from "./editor/input-layout";
import {
  applyEditorAction,
  createEditorDisplayState,
  createPasteAction,
  displayOffsetToSourceOffset,
  type EditorDisplayState,
  type EditorTextState,
  splitEditorDisplayRange,
} from "./editor/state";

const MAX_INPUT_LINES = 5;
const PROMPT = "> ";

export type TextPromptOptions = {
  title: string;
  initialValue?: string;
  placeholder?: string;
  collapseLongPastes?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

export class TextPrompt implements Component {
  private state: EditorTextState;
  private readonly bracketedPaste = new BracketedPasteBuffer();
  private inputColumns = 80;
  private inputVisibleLines = MAX_INPUT_LINES;
  private inputViewportStartLine: number | undefined;

  constructor(private readonly options: TextPromptOptions) {
    const value = normalizeLineEndings(options.initialValue ?? "");
    this.state = {
      value,
      cursorOffset: value.length,
      collapsedPastes: [],
    };
  }

  getText(): string {
    return this.state.value;
  }

  render(width: number, availableHeight?: number): string[] {
    const frameWidth = Math.max(width, 8);
    const contentWidth = Math.max(1, frameWidth - 4);
    const inputColumns = Math.max(1, contentWidth - visibleWidth(PROMPT));
    const maximumInputLines = visibleLimitForHeight(MAX_INPUT_LINES, availableHeight, 3);
    this.inputColumns = inputColumns;
    this.inputVisibleLines = maximumInputLines;
    const display = createEditorDisplayState(this.state);
    const layout = createInputLayout({
      value: display.value,
      cursorOffset: display.cursorOffset,
      columns: inputColumns,
      maxLines: maximumInputLines,
      preferredStartLine: this.inputViewportStartLine,
    });
    this.inputViewportStartLine = layout.startLine;
    const lines = [
      color(summarizeText(this.options.title), tuiTheme.bottomTitle),
      `+${"-".repeat(frameWidth - 2)}+`,
    ];

    for (const [index, line] of layout.lines.entries()) {
      const linePrompt = index === 0 ? PROMPT : " ".repeat(visibleWidth(PROMPT));
      const content = renderHighlightedLine([
        { text: linePrompt, color: tuiTheme.user },
        ...this.renderLine(line, index === layout.cursor.line, display),
      ]);

      lines.push(`| ${padRightAnsi(content, contentWidth)} |`);
    }

    lines.push(`+${"-".repeat(frameWidth - 2)}+`);

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    const paste = this.bracketedPaste.consume(data);

    if (paste !== undefined) {
      if (paste.text) {
        this.applyPaste(paste.text);
      }
      if (paste.remaining) {
        queueMicrotask(() => this.handleInput(paste.remaining));
      }
      return;
    }

    if (isEscape(data)) {
      this.options.onCancel();
      return;
    }

    if (isShiftEnter(data)) {
      this.applyText("\n");
      return;
    }

    if (isEnter(data)) {
      this.options.onSubmit(this.state.value);
      return;
    }

    if (isLeft(data)) {
      this.applyAction({ type: "moveLeft" });
      return;
    }

    if (isRight(data)) {
      this.applyAction({ type: "moveRight" });
      return;
    }

    if (isHome(data)) {
      this.applyAction({ type: "moveStart" });
      return;
    }

    if (isEnd(data)) {
      this.applyAction({ type: "moveEnd" });
      return;
    }

    if (isBackspace(data)) {
      this.applyAction({ type: "deleteBefore" });
      return;
    }

    if (isDelete(data)) {
      this.applyAction({ type: "deleteAfter" });
      return;
    }

    if (isUp(data) || isDown(data)) {
      this.moveVertically(isUp(data) ? -1 : 1);
      return;
    }

    if (isPrintable(data)) {
      this.applyText(data);
    }
  }

  private renderLine(
    line: InputLayoutLine,
    showCursor: boolean,
    display: EditorDisplayState,
  ): HighlightedLineToken[] {
    if (!showCursor) {
      return this.renderInputTokens(line.text, line.startOffset, display);
    }

    if (!this.state.value) {
      return [
        { text: CURSOR_MARKER, color: tuiTheme.userMessageText },
        ...(this.options.placeholder
          ? [{ text: this.options.placeholder, color: tuiTheme.muted }]
          : []),
      ];
    }

    if (display.cursorOffset < line.startOffset || display.cursorOffset > line.endOffset) {
      return this.renderInputTokens(line.text, line.startOffset, display);
    }

    const relativeOffset = display.cursorOffset - line.startOffset;

    return [
      ...this.renderInputTokens(line.text.slice(0, relativeOffset), line.startOffset, display),
      { text: CURSOR_MARKER, color: tuiTheme.userMessageText },
      ...this.renderInputTokens(line.text.slice(relativeOffset), display.cursorOffset, display),
    ];
  }

  private renderInputTokens(
    text: string,
    absoluteStart: number,
    display: EditorDisplayState,
  ): HighlightedLineToken[] {
    return splitEditorDisplayRange(display, absoluteStart, absoluteStart + text.length).map(
      (segment) => ({
        text: segment.text,
        color: segment.collapsedPaste ? tuiTheme.muted : tuiTheme.userMessageText,
      }),
    );
  }

  private applyText(text: string): void {
    const normalized = normalizeLineEndings(text);

    if (normalized) {
      this.applyAction({ type: "insert", text: normalized });
    }
  }

  private applyPaste(text: string): void {
    const normalized = normalizeLineEndings(text);

    if (normalized) {
      this.applyAction(
        this.options.collapseLongPastes === false
          ? { type: "insert", text: normalized }
          : createPasteAction(normalized),
      );
    }
  }

  private applyAction(action: Parameters<typeof applyEditorAction>[1]): void {
    this.state = applyEditorAction(this.state, action);
  }

  private moveVertically(direction: -1 | 1): void {
    const display = createEditorDisplayState(this.state);
    const currentLayout = createInputLayout({
      value: display.value,
      cursorOffset: display.cursorOffset,
      columns: this.inputColumns,
      maxLines: this.inputVisibleLines,
      preferredStartLine: this.inputViewportStartLine,
    });
    const displayCursorOffset = moveInputCursorVertically({
      value: display.value,
      cursorOffset: display.cursorOffset,
      columns: this.inputColumns,
      direction,
    });

    if (displayCursorOffset === undefined) {
      return;
    }

    this.inputViewportStartLine = currentLayout.startLine;
    this.state = {
      ...this.state,
      cursorOffset: displayOffsetToSourceOffset(display, displayCursorOffset),
    };
  }
}
