import type { UserImage } from "@/core";

import {
  color,
  dim,
  graphemeSegments,
  type HighlightedLineToken,
  normalizeLineEndings,
  padRightAnsi,
  renderHighlightedLine,
  stripTerminalControlSequences,
  truncateToWidth,
  visibleWidth,
} from "../../render";
import type { Component } from "../../runtime";
import {
  CURSOR_MARKER,
  isBackspace,
  isCtrlV,
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
import {
  applyEditorAction,
  type CollapsedPaste,
  createEditorDisplayState,
  createPasteAction,
  displayOffsetToSourceOffset,
  type EditorDisplayState,
  type EditorTextState,
  LONG_PASTE_CHARACTER_THRESHOLD,
  splitEditorDisplayRange,
} from "./state";
import { renderStatusLine, type StatusLineState } from "./status-line";

const MAX_INPUT_LINES = 5;
const COMMAND_PALETTE_VISIBLE_LIMIT = 10;
const QUEUED_INPUT_VISIBLE_LIMIT = 5;
const MAX_INPUT_IMAGES = 10;
const PROMPT = "> ";

export type EditorOptions = {
  model?: string;
  cleanMode?: boolean;
  commandPaletteVisibleLimit?: number;
  collapseLongPastes?: boolean;
};

export type EditorQueuedInput = {
  content: string;
  imageCount?: number;
  delivery: "turn" | "run" | "scheduled";
};

export type EditorScheduledInputSummary = {
  count: number;
  nextAt: Date;
};

type EditorHistoryEntry = {
  value: string;
  collapsedPastes: CollapsedPaste[];
};

export class Editor implements Component {
  private state: EditorTextState = {
    value: "",
    cursorOffset: 0,
    collapsedPastes: [],
  };
  private history: EditorHistoryEntry[] = [];
  private historyIndex = -1;
  private readonly commandViewport: ListViewport;
  private readonly maximumVisibleCommands: number;
  private readonly collapseLongPastes: boolean;
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
  private queuedInputs: EditorQueuedInput[] = [];
  private scheduledInputSummary?: EditorScheduledInputSummary;
  private images: UserImage[] = [];
  // Keep the selected tip stable between submissions so terminal redraws do not make it flicker.
  private placeholder = createRandomPromptPlaceholder();

  onSubmit?: (submit: PromptSubmit) => void;
  onQueue?: (submit: PromptSubmit) => void;
  onPasteClipboard?: () => void;

  constructor(options: EditorOptions = {}) {
    this.model = options.model;
    this.statusState.cleanMode = options.cleanMode;
    this.maximumVisibleCommands =
      options.commandPaletteVisibleLimit ?? COMMAND_PALETTE_VISIBLE_LIMIT;
    this.collapseLongPastes = options.collapseLongPastes ?? true;
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
      collapsedPastes: [],
    };
    this.inputViewportStartLine = undefined;
    this.historyIndex = -1;
    this.syncCommandSelection();
  }

  clear(): void {
    this.setText("");
    this.images = [];
  }

  attachImage(image: UserImage): void {
    if (this.images.length >= MAX_INPUT_IMAGES) {
      throw new Error(`Kana supports at most ${MAX_INPUT_IMAGES} images in one input.`);
    }
    this.images.push(structuredClone(image));
  }

  setModel(model: string | undefined): void {
    this.model = model;
  }

  addToHistory(value: string): void {
    const prompt = value.trim();

    if (!prompt || this.history[0]?.value === prompt) {
      return;
    }

    this.history.unshift(this.createHistoryEntry(prompt));

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

  setQueuedInputs(inputs: EditorQueuedInput[]): void {
    this.queuedInputs = structuredClone(inputs);
  }

  setScheduledInputSummary(summary: EditorScheduledInputSummary | undefined): void {
    this.scheduledInputSummary = summary === undefined ? undefined : structuredClone(summary);
  }

  render(width: number, availableHeight?: number): string[] {
    const frameWidth = Math.max(width, 8);
    const contentWidth = Math.max(1, frameWidth - 4);
    const inputColumns = Math.max(1, contentWidth - visibleWidth(PROMPT));
    const commandState = getCommandState(this.state.value);
    const showStatus =
      !commandState.showPalette && (availableHeight === undefined || availableHeight >= 5);
    const imageRows = this.images.length > 0 ? 1 : 0;
    const inputReservedRows =
      2 + imageRows + (showStatus ? 1 : 0) + (commandState.showPalette ? 3 : 0);
    const maximumInputLines = visibleLimitForHeight(
      MAX_INPUT_LINES,
      availableHeight,
      inputReservedRows,
    );
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
    const lines = [`+${"-".repeat(frameWidth - 2)}+`];

    if (this.images.length > 0) {
      const summary = color(formatImageSummary(this.images), tuiTheme.command);
      lines.push(`| ${padRightAnsi(truncateToWidth(summary, contentWidth, "…"), contentWidth)} |`);
    }

    for (const [index, line] of layout.lines.entries()) {
      const linePrompt = index === 0 ? PROMPT : " ".repeat(visibleWidth(PROMPT));
      const tokens: HighlightedLineToken[] = [
        ...(linePrompt ? [{ text: linePrompt, color: tuiTheme.user }] : []),
        ...this.renderLine(line, index === layout.cursor.line, display),
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

    if (
      !commandState.showPalette &&
      (this.queuedInputs.length > 0 || this.scheduledInputSummary !== undefined)
    ) {
      const queuedInputHeight =
        availableHeight === undefined
          ? undefined
          : Math.max(0, Math.floor(availableHeight) - lines.length);
      lines.push(...this.renderInputQueue(width, queuedInputHeight));
    }

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

    if (isCtrlV(data)) {
      this.onPasteClipboard?.();
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
        this.onSubmit?.(this.withImages(submit));
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
      if (!this.state.value && this.images.length > 0) {
        this.images.pop();
        return;
      }
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
        return;
      }

      const submit = createCommandSubmit(this.state.value, command);
      if (submit) {
        this.onQueue?.(this.withImages(submit));
      }
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
        { text: truncateToWidth(this.placeholder, this.inputColumns, ""), color: tuiTheme.muted },
      ];
    }

    if (display.cursorOffset < line.startOffset || display.cursorOffset > line.endOffset) {
      return this.renderInputTokens(line.text, line.startOffset, display);
    }

    const relativeOffset = display.cursorOffset - line.startOffset;
    const beforeCursor = line.text.slice(0, relativeOffset);
    const afterCursor = line.text.slice(relativeOffset);

    return [
      ...this.renderInputTokens(beforeCursor, line.startOffset, display),
      { text: CURSOR_MARKER, color: tuiTheme.userMessageText },
      ...this.renderInputTokens(afterCursor, display.cursorOffset, display),
    ];
  }

  private renderInputTokens(
    text: string,
    absoluteStart: number,
    display: EditorDisplayState,
  ): HighlightedLineToken[] {
    return splitEditorDisplayRange(display, absoluteStart, absoluteStart + text.length).flatMap(
      (segment) =>
        segment.collapsedPaste
          ? [{ text: segment.text, color: tuiTheme.muted }]
          : this.renderCommandInputTokens(segment.text, segment.startOffset, display.value),
    );
  }

  private renderCommandInputTokens(
    text: string,
    absoluteStart: number,
    displayValue: string,
  ): HighlightedLineToken[] {
    const commandEnd = commandTokenEnd(displayValue);

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

  private renderQueuedInputs(width: number, availableHeight?: number): string[] {
    const maximumRows =
      availableHeight === undefined
        ? QUEUED_INPUT_VISIBLE_LIMIT + 1
        : Math.max(0, Math.floor(availableHeight));
    if (maximumRows === 0) {
      return [];
    }

    const header = color(`Queued inputs · ${this.queuedInputs.length}`, tuiTheme.command);
    if (maximumRows === 1) {
      return [header];
    }

    const detailRows = Math.min(maximumRows - 1, QUEUED_INPUT_VISIBLE_LIMIT);
    const needsOverflow = this.queuedInputs.length > detailRows;
    const visibleCount = needsOverflow && detailRows > 1 ? detailRows - 1 : detailRows;
    const lines = [header];

    for (const input of this.queuedInputs.slice(0, visibleCount)) {
      const delivery =
        input.delivery === "turn"
          ? "next turn"
          : input.delivery === "run"
            ? "next run"
            : "scheduled";
      const content = stripTerminalControlSequences(input.content).replace(/\s+/g, " ").trim();
      const preview = [content, input.imageCount ? `[${input.imageCount} image(s)]` : ""]
        .filter(Boolean)
        .join(" ");
      const prefix = `  ${delivery.padEnd(9)} · `;
      lines.push(
        truncateToWidth(
          `${color(prefix, tuiTheme.muted)}${color(preview, tuiTheme.userMessageText)}`,
          width,
          "…",
        ),
      );
    }

    if (needsOverflow && detailRows > 1) {
      lines.push(dim(`  … ${this.queuedInputs.length - visibleCount} more`));
    }
    return lines;
  }

  private renderInputQueue(width: number, availableHeight?: number): string[] {
    if (availableHeight !== undefined && availableHeight <= 0) {
      return [];
    }

    const reserveScheduledRow =
      this.scheduledInputSummary !== undefined &&
      this.queuedInputs.length > 0 &&
      (availableHeight === undefined || availableHeight > 1);
    const queuedHeight =
      availableHeight === undefined
        ? undefined
        : Math.max(0, availableHeight - (reserveScheduledRow ? 1 : 0));
    const lines = this.queuedInputs.length > 0 ? this.renderQueuedInputs(width, queuedHeight) : [];

    if (
      this.scheduledInputSummary &&
      (availableHeight === undefined || lines.length < availableHeight)
    ) {
      const nextAt = formatClockTime(this.scheduledInputSummary.nextAt);
      lines.push(
        truncateToWidth(
          color(
            `Scheduled · ${this.scheduledInputSummary.count} · next ${nextAt}`,
            tuiTheme.command,
          ),
          width,
          "…",
        ),
      );
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

  private applyPaste(text: string): void {
    const normalized = normalizeLineEndings(text);

    if (!normalized) {
      return;
    }

    this.applyAction(
      this.collapseLongPastes
        ? createPasteAction(normalized)
        : { type: "insert", text: normalized },
    );
    this.historyIndex = -1;
  }

  private applyAction(action: Parameters<typeof applyEditorAction>[1]): void {
    this.state = applyEditorAction(this.state, action);
    this.syncCommandSelection();
  }

  private withImages(submit: PromptSubmit): PromptSubmit {
    return submit.type === "message" && this.images.length > 0
      ? { ...submit, images: structuredClone(this.images) }
      : submit;
  }

  private moveVertically(direction: -1 | 1): boolean {
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
      return false;
    }

    this.inputViewportStartLine = currentLayout.startLine;
    this.state = {
      ...this.state,
      cursorOffset: displayOffsetToSourceOffset(display, displayCursorOffset),
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
    const display = createEditorDisplayState(this.state);
    this.inputViewportStartLine =
      direction === -1
        ? 0
        : Math.max(
            0,
            findInputCursorLine({
              value: display.value,
              cursorOffset: display.cursorOffset,
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
    const entry = this.history[this.historyIndex];
    this.setText(entry?.value ?? "");
    if (entry) {
      this.state = {
        ...this.state,
        collapsedPastes: structuredClone(entry.collapsedPastes),
      };
    }
    this.historyIndex = nextIndex;
  }

  private createHistoryEntry(value: string): EditorHistoryEntry {
    if (this.state.value.trim() !== value) {
      return { value, collapsedPastes: [] };
    }

    const trimmedStartOffset = this.state.value.length - this.state.value.trimStart().length;
    const trimmedEndOffset = trimmedStartOffset + value.length;
    const collapsedPastes = (this.state.collapsedPastes ?? []).flatMap(
      (paste): CollapsedPaste[] => {
        const sourceStartOffset = Math.max(paste.startOffset, trimmedStartOffset);
        const sourceEndOffset = Math.min(paste.endOffset, trimmedEndOffset);
        if (sourceStartOffset >= sourceEndOffset) {
          return [];
        }

        const characterCount =
          sourceStartOffset === paste.startOffset && sourceEndOffset === paste.endOffset
            ? paste.characterCount
            : graphemeSegments(this.state.value.slice(sourceStartOffset, sourceEndOffset)).length;
        if (characterCount < LONG_PASTE_CHARACTER_THRESHOLD) {
          return [];
        }

        return [
          {
            startOffset: sourceStartOffset - trimmedStartOffset,
            endOffset: sourceEndOffset - trimmedStartOffset,
            characterCount,
          },
        ];
      },
    );

    return { value, collapsedPastes };
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

function formatClockTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function formatImageSummary(images: UserImage[]): string {
  const dimensions = images
    .slice(0, 3)
    .map((image) => `${image.width}×${image.height}`)
    .join(", ");
  const remaining = images.length > 3 ? `, +${images.length - 3}` : "";
  const totalBytes = images.reduce((total, image) => total + base64ByteLength(image.data), 0);
  return `Images · ${images.length} · ${dimensions}${remaining} · ${formatByteSize(totalBytes)}`;
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatByteSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function commandTokenEnd(value: string): number | undefined {
  if (!value.startsWith("/")) {
    return undefined;
  }

  const match = /^\/\S*/.exec(value);
  return match?.[0].length;
}
