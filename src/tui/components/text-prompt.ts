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
import { isDown, isEnter, isEscape, isPrintable, isShiftEnter, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { BracketedPasteBuffer } from "../utils/bracketed-paste";
import { visibleLimitForHeight } from "../utils/list-viewport";
import { createEditorDisplayState, splitEditorDisplayRange } from "./editor/display";
import { resolveEditorInputAction } from "./editor/input-actions";
import {
  createPasteInsertAction,
  createTextInsertAction,
  moveCursorVertically,
  renderInputLine,
} from "./editor/input-frame";
import { createInputLayout } from "./editor/input-layout";
import { applyEditorAction } from "./editor/state";
import type { EditorDisplayState, EditorTextState } from "./editor/text-state";

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
      truncateToWidth(color(summarizeText(this.options.title), tuiTheme.bottomTitle), width),
      `+${"-".repeat(frameWidth - 2)}+`,
    ];

    for (const [index, line] of layout.lines.entries()) {
      const linePrompt = index === 0 ? PROMPT : " ".repeat(visibleWidth(PROMPT));
      const content = renderHighlightedLine([
        { text: linePrompt, color: tuiTheme.user },
        ...renderInputLine(line, index === layout.cursor.line, display, {
          placeholder: this.options.placeholder,
          renderText: (text, start) => this.renderInputTokens(text, start, display),
        }),
      ]);

      lines.push(`| ${padRightAnsi(content, contentWidth)} |`);
    }

    lines.push(`+${"-".repeat(frameWidth - 2)}+`);

    return lines.map((line) => truncateToWidth(line, width));
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

    const editAction = resolveEditorInputAction(data);
    if (editAction) {
      this.state = applyEditorAction(this.state, editAction);
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
    const action = createTextInsertAction(text);
    if (action) this.state = applyEditorAction(this.state, action);
  }

  private applyPaste(text: string): void {
    const action = createPasteInsertAction(text, this.options.collapseLongPastes !== false);
    if (action) this.state = applyEditorAction(this.state, action);
  }

  private moveVertically(direction: -1 | 1): void {
    const moved = moveCursorVertically(
      this.state,
      {
        columns: this.inputColumns,
        visibleLines: this.inputVisibleLines,
        startLine: this.inputViewportStartLine,
      },
      direction,
    );
    if (moved) {
      this.state = moved.state;
      this.inputViewportStartLine = moved.startLine;
    }
  }
}
