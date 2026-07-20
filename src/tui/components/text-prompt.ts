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
import { applyEditorAction, type EditorTextState } from "./editor/state";

const MAX_INPUT_LINES = 5;
const PROMPT = "> ";

export type TextPromptOptions = {
  title: string;
  initialValue?: string;
  placeholder?: string;
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
    const layout = createInputLayout({
      value: this.state.value,
      cursorOffset: this.state.cursorOffset,
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
        ...this.renderLine(line, index === layout.cursor.line),
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
        this.applyText(paste.text);
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

  private renderLine(line: InputLayoutLine, showCursor: boolean): HighlightedLineToken[] {
    if (!showCursor) {
      return line.text ? [{ text: line.text, color: tuiTheme.userMessageText }] : [];
    }

    if (!this.state.value) {
      return [
        { text: CURSOR_MARKER, color: tuiTheme.userMessageText },
        ...(this.options.placeholder
          ? [{ text: this.options.placeholder, color: tuiTheme.muted }]
          : []),
      ];
    }

    if (this.state.cursorOffset < line.startOffset || this.state.cursorOffset > line.endOffset) {
      return line.text ? [{ text: line.text, color: tuiTheme.userMessageText }] : [];
    }

    const relativeOffset = this.state.cursorOffset - line.startOffset;

    return [
      { text: line.text.slice(0, relativeOffset), color: tuiTheme.userMessageText },
      { text: CURSOR_MARKER, color: tuiTheme.userMessageText },
      { text: line.text.slice(relativeOffset), color: tuiTheme.userMessageText },
    ];
  }

  private applyText(text: string): void {
    const normalized = normalizeLineEndings(text);

    if (normalized) {
      this.applyAction({ type: "insert", text: normalized });
    }
  }

  private applyAction(action: Parameters<typeof applyEditorAction>[1]): void {
    this.state = applyEditorAction(this.state, action);
  }

  private moveVertically(direction: -1 | 1): void {
    const currentLayout = createInputLayout({
      value: this.state.value,
      cursorOffset: this.state.cursorOffset,
      columns: this.inputColumns,
      maxLines: this.inputVisibleLines,
      preferredStartLine: this.inputViewportStartLine,
    });
    const cursorOffset = moveInputCursorVertically({
      value: this.state.value,
      cursorOffset: this.state.cursorOffset,
      columns: this.inputColumns,
      direction,
    });

    if (cursorOffset === undefined) {
      return;
    }

    this.inputViewportStartLine = currentLayout.startLine;
    this.state = {
      ...this.state,
      cursorOffset,
    };
  }
}
