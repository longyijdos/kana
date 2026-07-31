import {
  color,
  dim,
  type HighlightedLineToken,
  normalizeLineEndings,
  padRightAnsi,
  renderHighlightedLine,
  truncateToWidth,
  visibleWidth,
} from "../../render";
import type { Component } from "../../runtime";
import {
  CURSOR_MARKER,
  isBackspace,
  isDelete,
  isDown,
  isEnd,
  isEnter,
  isHome,
  isLeft,
  isPrintable,
  isRight,
  isShiftEnter,
  isTab,
  isUp,
} from "../../runtime";
import { tuiTheme } from "../../theme";
import { BracketedPasteBuffer } from "../../utils/bracketed-paste";
import { ListViewport, visibleLimitForHeight } from "../../utils/list-viewport";
import {
  completeCommand,
  createCommandSubmit,
  createRandomPromptPlaceholder,
  formatPromptCommandHelpLine,
  getCommandState,
  type PromptSubmit,
} from "./commands";
import {
  createInputLayout,
  findInputCursorLine,
  type InputLayoutLine,
  moveInputCursorVertically,
} from "./input-layout";
import { applyEditorAction, type EditorTextState } from "./state";
import { renderStatusLine, type StatusLineState } from "./status-line";

const MAX_INPUT_LINES = 5;
const COMMAND_PALETTE_VISIBLE_LIMIT = 10;
const PROMPT = "> ";

export type EditorOptions = {
  model?: string;
  cleanMode?: boolean;
  commandPaletteVisibleLimit?: number;
};

export class Editor implements Component {
  private state: EditorTextState = {
    value: "",
    cursorOffset: 0,
  };
  private history: string[] = [];
  private historyIndex = -1;
  private readonly commandViewport: ListViewport;
  private readonly maximumVisibleCommands: number;
  private lastCommandQuery = "";
  private readonly bracketedPaste = new BracketedPasteBuffer();
  private model?: string;
  private inputColumns = 80;
  private inputVisibleLines = MAX_INPUT_LINES;
  private inputViewportStartLine: number | undefined;
  private statusState: StatusLineState = {
    phase: "idle",
    running: false,
  };
  // Keep the selected tip stable between submissions so terminal redraws do not make it flicker.
  private placeholder = createRandomPromptPlaceholder();

  onSubmit?: (submit: PromptSubmit) => void;

  constructor(options: EditorOptions = {}) {
    this.model = options.model;
    this.statusState.cleanMode = options.cleanMode;
    this.maximumVisibleCommands =
      options.commandPaletteVisibleLimit ?? COMMAND_PALETTE_VISIBLE_LIMIT;
    this.commandViewport = new ListViewport(this.maximumVisibleCommands);
  }

  getText(): string {
    return this.state.value;
  }

  setText(value: string): void {
    const normalized = normalizeLineEndings(value);

    this.state = {
      value: normalized,
      cursorOffset: normalized.length,
    };
    this.inputViewportStartLine = undefined;
    this.historyIndex = -1;
    this.syncCommandSelection();
  }

  clear(): void {
    this.setText("");
  }

  setModel(model: string | undefined): void {
    this.model = model;
  }

  addToHistory(value: string): void {
    const prompt = value.trim();

    if (!prompt || this.history[0] === prompt) {
      return;
    }

    this.history.unshift(prompt);

    if (this.history.length > 100) {
      this.history.pop();
    }
  }

  updateStatus(state: Partial<StatusLineState>): void {
    this.statusState = {
      ...this.statusState,
      ...state,
    };
  }

  render(width: number, availableHeight?: number): string[] {
    const frameWidth = Math.max(width, 8);
    const contentWidth = Math.max(1, frameWidth - 4);
    const inputColumns = Math.max(1, contentWidth - visibleWidth(PROMPT));
    const commandState = getCommandState(this.state.value);
    const showStatus =
      !commandState.showPalette && (availableHeight === undefined || availableHeight >= 5);
    const inputReservedRows = 2 + (showStatus ? 1 : 0) + (commandState.showPalette ? 3 : 0);
    const maximumInputLines = visibleLimitForHeight(
      MAX_INPUT_LINES,
      availableHeight,
      inputReservedRows,
    );
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
    const lines = [`+${"-".repeat(frameWidth - 2)}+`];

    for (const [index, line] of layout.lines.entries()) {
      const linePrompt = index === 0 ? PROMPT : " ".repeat(visibleWidth(PROMPT));
      const tokens: HighlightedLineToken[] = [
        ...(linePrompt ? [{ text: linePrompt, color: tuiTheme.user }] : []),
        ...this.renderLine(line, index === layout.cursor.line),
      ];
      const content = renderHighlightedLine(tokens);

      lines.push(`| ${padRightAnsi(content, contentWidth)} |`);
    }

    lines.push(`+${"-".repeat(frameWidth - 2)}+`);
    const commandPaletteHeight =
      availableHeight === undefined
        ? undefined
        : Math.max(1, Math.floor(availableHeight) - lines.length);
    lines.push(...this.renderCommandPalette(frameWidth, commandPaletteHeight));

    if (showStatus) {
      lines.push(renderStatusLine(width, this.model, this.statusState));
    }

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

    if (isShiftEnter(data)) {
      this.applyText("\n");
      return;
    }

    if (isEnter(data)) {
      this.placeholder = createRandomPromptPlaceholder(Math.random, this.placeholder);
      const commandState = getCommandState(this.state.value);
      const submit = createCommandSubmit(
        this.state.value,
        commandState.suggestions[this.commandViewport.selectedIndex],
      );

      if (submit) {
        this.onSubmit?.(submit);
      }
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
      const commandState = getCommandState(this.state.value);

      if (commandState.showPalette && commandState.suggestions.length > 0) {
        this.commandViewport.move(isUp(data) ? -1 : 1, commandState.suggestions.length);
        return;
      }

      const direction = isUp(data) ? -1 : 1;

      if (!this.moveVertically(direction) && !this.moveToBoundary(direction)) {
        this.navigateHistory(direction === -1 ? 1 : -1);
      }
      return;
    }

    if (isTab(data)) {
      const commandState = getCommandState(this.state.value);
      const command = commandState.suggestions[this.commandViewport.selectedIndex];

      if (commandState.showPalette && command) {
        this.setText(completeCommand(command));
      }
      return;
    }

    if (isPrintable(data)) {
      this.applyText(data);
    }
  }

  private renderLine(line: InputLayoutLine, showCursor: boolean): HighlightedLineToken[] {
    if (!showCursor) {
      return this.renderCommandInputTokens(line.text, line.startOffset);
    }

    if (!this.state.value) {
      return [
        { text: CURSOR_MARKER, color: tuiTheme.userMessageText },
        { text: this.placeholder, color: tuiTheme.muted },
      ];
    }

    if (this.state.cursorOffset < line.startOffset || this.state.cursorOffset > line.endOffset) {
      return this.renderCommandInputTokens(line.text, line.startOffset);
    }

    const relativeOffset = this.state.cursorOffset - line.startOffset;
    const beforeCursor = line.text.slice(0, relativeOffset);
    const afterCursor = line.text.slice(relativeOffset);

    return [
      ...this.renderCommandInputTokens(beforeCursor, line.startOffset),
      { text: CURSOR_MARKER, color: tuiTheme.userMessageText },
      ...this.renderCommandInputTokens(afterCursor, this.state.cursorOffset),
    ];
  }

  private renderCommandInputTokens(text: string, absoluteStart: number): HighlightedLineToken[] {
    const commandEnd = commandTokenEnd(this.state.value);

    if (commandEnd === undefined || !text) {
      return text ? [{ text, color: tuiTheme.userMessageText }] : [];
    }

    const absoluteEnd = absoluteStart + text.length;

    if (absoluteStart >= commandEnd || absoluteEnd <= 0) {
      return [{ text, color: tuiTheme.userMessageText }];
    }

    const highlightEnd = Math.min(text.length, commandEnd - absoluteStart);
    const command = text.slice(0, highlightEnd);
    const after = text.slice(highlightEnd);

    return [
      ...(command ? [{ text: command, color: tuiTheme.command }] : []),
      ...(after ? [{ text: after, color: tuiTheme.userMessageText }] : []),
    ];
  }

  private renderCommandPalette(width: number, availableHeight?: number): string[] {
    const commandState = getCommandState(this.state.value);

    if (!commandState.showPalette) {
      return [];
    }

    if (commandState.suggestions.length === 0) {
      return [color("No matching commands", tuiTheme.error)];
    }

    this.commandViewport.setVisibleLimit(
      visibleLimitForHeight(this.maximumVisibleCommands, availableHeight, 2),
      commandState.suggestions.length,
    );
    const viewport = this.commandViewport.window(commandState.suggestions.length);
    const lines: string[] = [];

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier commands`));
    }

    for (let index = viewport.start; index < viewport.end; index += 1) {
      const command = commandState.suggestions[index];
      const prefix = index === this.commandViewport.selectedIndex ? "> " : "  ";
      const line = `${prefix}${formatPromptCommandHelpLine(command)}`;

      lines.push(
        index === this.commandViewport.selectedIndex
          ? color(truncateToWidth(line, width, ""), tuiTheme.commandSelected)
          : truncateToWidth(line, width, ""),
      );
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more commands`));
    }

    return lines;
  }

  private applyText(text: string): void {
    const normalized = normalizeLineEndings(text);

    if (!normalized) {
      return;
    }

    this.applyAction({
      type: "insert",
      text: normalized,
    });
    this.historyIndex = -1;
  }

  private applyAction(action: Parameters<typeof applyEditorAction>[1]): void {
    this.state = applyEditorAction(this.state, action);
    this.syncCommandSelection();
  }

  private moveVertically(direction: -1 | 1): boolean {
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
      return false;
    }

    this.inputViewportStartLine = currentLayout.startLine;
    this.state = {
      ...this.state,
      cursorOffset,
    };
    this.syncCommandSelection();

    return true;
  }

  private moveToBoundary(direction: -1 | 1): boolean {
    const cursorOffset = direction === -1 ? 0 : this.state.value.length;

    if (this.state.cursorOffset === cursorOffset) {
      return false;
    }

    this.state = {
      ...this.state,
      cursorOffset,
    };
    this.inputViewportStartLine =
      direction === -1
        ? 0
        : Math.max(
            0,
            findInputCursorLine({
              value: this.state.value,
              cursorOffset,
              columns: this.inputColumns,
            }) -
              this.inputVisibleLines +
              1,
          );
    this.syncCommandSelection();

    return true;
  }

  private navigateHistory(direction: 1 | -1): void {
    if (this.history.length === 0) {
      return;
    }

    const nextIndex = this.historyIndex + direction;

    if (nextIndex < -1 || nextIndex >= this.history.length) {
      return;
    }

    this.historyIndex = nextIndex;
    this.setText(this.historyIndex === -1 ? "" : (this.history[this.historyIndex] ?? ""));
    this.historyIndex = nextIndex;
  }

  private syncCommandSelection(): void {
    const commandState = getCommandState(this.state.value);

    if (commandState.query !== this.lastCommandQuery) {
      this.commandViewport.moveTo(0, commandState.suggestions.length);
      this.lastCommandQuery = commandState.query;
      return;
    }

    this.commandViewport.moveTo(
      this.commandViewport.selectedIndex,
      commandState.suggestions.length,
    );
  }
}

function commandTokenEnd(value: string): number | undefined {
  if (!value.startsWith("/")) {
    return undefined;
  }

  const match = /^\/\S*/.exec(value);
  return match?.[0].length;
}
