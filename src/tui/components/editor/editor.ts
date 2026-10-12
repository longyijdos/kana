import type { UserImage } from "@/core";
import type { KanaPromptTemplate, KanaSkillActivation, MemoryConsolidationActivity } from "@/kana";

import {
  base64ByteLength,
  color,
  dim,
  formatByteSize,
  graphemeSegments,
  type HighlightedLineToken,
  normalizeLineEndings,
  padRightAnsi,
  renderHighlightedLine,
  truncateToWidth,
  visibleWidth,
} from "../../render";
import type { Component } from "../../runtime";
import {
  isCtrlKey,
  isCtrlV,
  isDown,
  isEnter,
  isEscape,
  isPrintable,
  isShiftEnter,
  isTab,
  isUp,
} from "../../runtime";
import { tuiTheme } from "../../theme";
import { BracketedPasteBuffer } from "../../utils/bracketed-paste";
import { ListViewport, visibleLimitForHeight } from "../../utils/list-viewport";
import {
  type CommandState,
  completeCommand,
  createCommandSubmit,
  createRandomPromptPlaceholder,
  formatPromptCommandHelpLine,
  getCommandState,
  type PromptCommand,
  type PromptSubmit,
} from "./commands";
import { resolveEditorInputAction } from "./input-actions";
import {
  createPasteInsertAction,
  createTextInsertAction,
  moveCursorVertically,
  renderInputLine,
} from "./input-frame";
import { createInputLayout, findInputCursorLine } from "./input-layout";
import {
  type EditorBackgroundActivityItem,
  type EditorInputPreviews,
  type EditorQueuedInput,
  type EditorScheduledInputSummary,
  type EditorUserTaskItem,
  hasInputPreviews,
  renderInputPreviews,
  renderMemoryActivity,
} from "./previews";
import {
  completeSkillReference,
  createSkillReferenceSubmit,
  formatSkillReferenceHelpLine,
  getSkillReferenceState,
  type SkillReferenceState,
} from "./skills";
import {
  applyEditorAction,
  type CollapsedPaste,
  createEditorDisplayState,
  type EditorAction,
  type EditorDisplayState,
  type EditorTextState,
  LONG_PASTE_CHARACTER_THRESHOLD,
  splitEditorDisplayRange,
} from "./state";
import { renderStatusLine, type StatusLineState } from "./status-line";
import {
  completePromptTemplate,
  createPromptTemplateSubmit,
  formatPromptTemplateHelpLine,
  getPromptTemplateState,
  type PromptTemplateState,
} from "./templates";

const MAX_INPUT_LINES = 5;
const COMMAND_PALETTE_VISIBLE_LIMIT = 10;
const MAX_INPUT_IMAGES = 10;
const PROMPT = "> ";

export type EditorOptions = {
  model?: string;
  cleanMode?: boolean;
  commandPaletteVisibleLimit?: number;
  collapseLongPastes?: boolean;
  promptTemplates?: readonly KanaPromptTemplate[];
  skills?: readonly KanaSkillActivation[];
};

type EditorHistoryEntry = {
  value: string;
  collapsedPastes: CollapsedPaste[];
};

type EditorPaletteState =
  | ({ kind: "command" } & CommandState)
  | ({ kind: "template" } & PromptTemplateState)
  | ({ kind: "skill" } & SkillReferenceState)
  | {
      kind: "none";
      isCommandMode: false;
      showPalette: false;
      query: "";
      suggestions: [];
    };

export class Editor implements Component {
  private state: EditorTextState = {
    value: "",
    cursorOffset: 0,
    collapsedPastes: [],
  };
  private history: EditorHistoryEntry[] = [];
  private historyIndex = -1;
  private readonly paletteViewport: ListViewport;
  private readonly maximumVisibleSuggestions: number;
  private readonly collapseLongPastes: boolean;
  private readonly promptTemplates: readonly KanaPromptTemplate[];
  private readonly skills: readonly KanaSkillActivation[];
  private lastPaletteKey = "";
  private readonly bracketedPaste = new BracketedPasteBuffer();
  private model?: string;
  private inputColumns = 80;
  private inputVisibleLines = MAX_INPUT_LINES;
  private inputViewportStartLine: number | undefined;
  private loading = false;
  private statusState: StatusLineState = {
    phase: "idle",
    running: false,
  };
  private previews: EditorInputPreviews = {
    queuedInputs: [],
    backgroundActivity: [],
    pendingUserTasks: [],
  };
  private memoryActivity: MemoryConsolidationActivity[] = [];
  private images: UserImage[] = [];
  // Keep the selected tip stable between submissions so terminal redraws do not make it flicker.
  private placeholder = createRandomPromptPlaceholder();

  onSubmit?: (submit: PromptSubmit) => void;
  onQueue?: (submit: PromptSubmit) => void;
  onPasteClipboard?: () => void;
  onEscape?: () => void;
  onError?: (error: unknown) => void;

  constructor(options: EditorOptions = {}) {
    this.model = options.model;
    this.statusState.cleanMode = options.cleanMode;
    this.maximumVisibleSuggestions =
      options.commandPaletteVisibleLimit ?? COMMAND_PALETTE_VISIBLE_LIMIT;
    this.collapseLongPastes = options.collapseLongPastes ?? true;
    this.promptTemplates = options.promptTemplates ?? [];
    this.skills = options.skills ?? [];
    this.paletteViewport = new ListViewport(this.maximumVisibleSuggestions);
  }

  getText(): string {
    return this.state.value;
  }

  setText(value: string): void {
    const normalized = normalizeLineEndings(value);
    const killBuffer = this.state.killBuffer;

    this.state = {
      value: normalized,
      cursorOffset: normalized.length,
      collapsedPastes: [],
      ...(killBuffer === undefined ? {} : { killBuffer }),
    };
    this.inputViewportStartLine = undefined;
    this.historyIndex = -1;
    this.syncPaletteSelection();
  }

  clear(): void {
    this.setText("");
    this.images = [];
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
  }

  hasDraft(): boolean {
    return this.state.value.length > 0 || this.images.length > 0;
  }

  attachImage(image: UserImage): void {
    if (this.images.length >= MAX_INPUT_IMAGES) {
      throw new Error(`Kana supports at most ${MAX_INPUT_IMAGES} images in one input.`);
    }
    this.images.push(image);
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
    this.previews = { ...this.previews, queuedInputs: inputs };
  }

  setScheduledInputSummary(summary: EditorScheduledInputSummary | undefined): void {
    this.previews = { ...this.previews, scheduledInputSummary: summary };
  }

  setBackgroundActivity(items: EditorBackgroundActivityItem[]): void {
    this.previews = { ...this.previews, backgroundActivity: items };
  }

  setPendingUserTasks(items: EditorUserTaskItem[]): void {
    this.previews = { ...this.previews, pendingUserTasks: items };
  }

  setMemoryActivity(items: MemoryConsolidationActivity[]): void {
    this.memoryActivity = items;
  }

  render(width: number, availableHeight?: number): string[] {
    const frameWidth = Math.max(width, 8);
    const contentWidth = Math.max(1, frameWidth - 4);
    const inputColumns = Math.max(1, contentWidth - visibleWidth(PROMPT));
    const paletteState = this.getPaletteState();
    const showPalette = !this.loading && paletteState.showPalette;
    const showStatus = !showPalette && (availableHeight === undefined || availableHeight >= 5);
    const imageRows = this.images.length > 0 ? 1 : 0;
    const showMemory =
      showStatus &&
      this.memoryActivity.length > 0 &&
      (availableHeight === undefined || availableHeight >= 5 + imageRows);
    const inputReservedRows =
      2 + imageRows + (showStatus ? 1 : 0) + (showPalette ? 3 : 0) + (showMemory ? 1 : 0);
    const maximumInputLines = visibleLimitForHeight(
      MAX_INPUT_LINES,
      availableHeight,
      inputReservedRows,
    );
    this.inputColumns = inputColumns;
    this.inputVisibleLines = maximumInputLines;
    const display = createEditorDisplayState(this.state);
    const inputValue = this.loading
      ? `${display.value}${display.value ? " " : ""}(Loading...)`
      : display.value;
    const layout = createInputLayout({
      value: inputValue,
      cursorOffset: this.loading ? inputValue.length : display.cursorOffset,
      columns: inputColumns,
      maxLines: maximumInputLines,
      preferredStartLine: this.inputViewportStartLine,
    });
    this.inputViewportStartLine = layout.startLine;
    const lines = [`+${"-".repeat(frameWidth - 2)}+`];

    if (this.images.length > 0) {
      const summary = color(formatImageSummary(this.images), tuiTheme.command);
      lines.push(`| ${padRightAnsi(truncateToWidth(summary, contentWidth), contentWidth)} |`);
    }

    for (const [index, line] of layout.lines.entries()) {
      const linePrompt = index === 0 ? PROMPT : " ".repeat(visibleWidth(PROMPT));
      const promptEnd = Math.max(0, display.value.length - line.startOffset);
      const tokens: HighlightedLineToken[] = this.loading
        ? [
            { text: linePrompt + line.text.slice(0, promptEnd), color: tuiTheme.muted },
            { text: line.text.slice(promptEnd), color: tuiTheme.shortcutHint },
          ]
        : [
            ...(linePrompt ? [{ text: linePrompt, color: tuiTheme.user }] : []),
            ...renderInputLine(line, index === layout.cursor.line, display, {
              placeholder: truncateToWidth(this.placeholder, this.inputColumns),
              renderText: (text, start) => this.renderInputTokens(text, start, display),
            }),
          ];
      const content = renderHighlightedLine(tokens);

      lines.push(`| ${padRightAnsi(content, contentWidth)} |`);
    }

    lines.push(`+${"-".repeat(frameWidth - 2)}+`);
    const commandPaletteHeight =
      availableHeight === undefined
        ? undefined
        : Math.max(1, Math.floor(availableHeight) - lines.length);
    if (showPalette) {
      lines.push(...this.renderSuggestionPalette(frameWidth, commandPaletteHeight));
    }

    if (showStatus) {
      lines.push(renderStatusLine(width, this.model, this.statusState));
    }

    if (showMemory) {
      lines.push(renderMemoryActivity(this.memoryActivity));
    }

    if (!showPalette && hasInputPreviews(this.previews)) {
      const previewHeight =
        availableHeight === undefined
          ? undefined
          : Math.max(0, Math.floor(availableHeight) - lines.length);
      lines.push(...renderInputPreviews(this.previews, width, previewHeight));
    }

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
      this.onEscape?.();
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
      const submit = this.createSubmit(this.getPaletteState());
      if (submit) {
        this.onSubmit?.(submit);
      }
      return;
    }

    const editAction = resolveEditorInputAction(data);
    if (editAction) {
      if (editAction.type === "deleteBefore" && !this.state.value && this.images.length > 0) {
        this.images.pop();
        return;
      }
      this.applyAction(editAction);
      return;
    }

    const historyUp = isCtrlKey(data, "p");
    const historyDown = isCtrlKey(data, "n");
    if (isUp(data) || isDown(data) || historyUp || historyDown) {
      const paletteState = this.getPaletteState();
      const direction = isUp(data) || historyUp ? -1 : 1;

      if (paletteState.showPalette && paletteState.suggestions.length > 0) {
        this.paletteViewport.move(direction, paletteState.suggestions.length);
        return;
      }

      if (historyUp || historyDown) {
        this.navigateHistory(direction === -1 ? 1 : -1);
        return;
      }

      if (!this.moveVertically(direction) && !this.moveToBoundary(direction)) {
        this.navigateHistory(direction === -1 ? 1 : -1);
      }
      return;
    }

    if (isTab(data)) {
      const paletteState = this.getPaletteState();
      const suggestion = paletteState.suggestions[this.paletteViewport.selectedIndex];

      if (paletteState.showPalette && suggestion) {
        this.setText(
          paletteState.kind === "skill"
            ? completeSkillReference(suggestion as KanaSkillActivation)
            : paletteState.kind === "template"
              ? completePromptTemplate(suggestion as KanaPromptTemplate)
              : completeCommand(suggestion as PromptCommand),
        );
        return;
      }

      const submit = this.createSubmit(paletteState);
      if (submit) {
        this.onQueue?.(submit);
      }
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
    return splitEditorDisplayRange(display, absoluteStart, absoluteStart + text.length).flatMap(
      (segment) =>
        segment.collapsedPaste
          ? [{ text: segment.text, color: tuiTheme.muted }]
          : this.renderSpecialInputTokens(segment.text, segment.startOffset, display.value),
    );
  }

  private renderSpecialInputTokens(
    text: string,
    absoluteStart: number,
    displayValue: string,
  ): HighlightedLineToken[] {
    const commandEnd = specialInputTokenEnd(displayValue);

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

  private renderSuggestionPalette(width: number, availableHeight?: number): string[] {
    const paletteState = this.getPaletteState();

    if (!paletteState.showPalette) {
      return [];
    }

    if (paletteState.suggestions.length === 0) {
      return [
        color(
          paletteState.kind === "template"
            ? "No matching prompt templates"
            : paletteState.kind === "skill"
              ? "No matching Skills"
              : "No matching commands",
          tuiTheme.error,
        ),
      ];
    }

    this.paletteViewport.setVisibleLimit(
      visibleLimitForHeight(this.maximumVisibleSuggestions, availableHeight, 2),
      paletteState.suggestions.length,
    );
    const viewport = this.paletteViewport.window(paletteState.suggestions.length);
    const lines: string[] = [];
    const label =
      paletteState.kind === "template"
        ? "templates"
        : paletteState.kind === "skill"
          ? "Skills"
          : "commands";

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier ${label}`));
    }

    for (let index = viewport.start; index < viewport.end; index += 1) {
      const suggestion = paletteState.suggestions[index];
      const prefix = index === this.paletteViewport.selectedIndex ? "> " : "  ";
      const helpLine =
        paletteState.kind === "skill"
          ? formatSkillReferenceHelpLine(suggestion as KanaSkillActivation, this.skills)
          : paletteState.kind === "template"
            ? formatPromptTemplateHelpLine(suggestion as KanaPromptTemplate, this.promptTemplates)
            : formatPromptCommandHelpLine(suggestion as PromptCommand);
      const line = `${prefix}${helpLine}`;

      lines.push(
        index === this.paletteViewport.selectedIndex
          ? color(truncateToWidth(line, width), tuiTheme.commandSelected)
          : truncateToWidth(line, width),
      );
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more ${label}`));
    }

    return lines;
  }

  private applyText(text: string): void {
    const action = createTextInsertAction(text);
    if (action) this.applyAction(action);
  }

  private applyPaste(text: string): void {
    const action = createPasteInsertAction(text, this.collapseLongPastes);
    if (action) this.applyAction(action);
  }

  private applyAction(action: EditorAction): void {
    const previousValue = this.state.value;
    this.state = applyEditorAction(this.state, action);
    if (this.state.value !== previousValue) {
      this.historyIndex = -1;
    }
    this.syncPaletteSelection();
  }

  // Builds the submission for the current input, resolving the selected palette
  // suggestion. Invalid input is reported through onError.
  private createSubmit(paletteState: EditorPaletteState): PromptSubmit | undefined {
    const selected = paletteState.suggestions[this.paletteViewport.selectedIndex];
    try {
      const submit =
        paletteState.kind === "skill"
          ? createSkillReferenceSubmit(
              this.state.value,
              selected as KanaSkillActivation | undefined,
              this.skills,
            )
          : paletteState.kind === "template"
            ? createPromptTemplateSubmit(
                this.state.value,
                selected as KanaPromptTemplate | undefined,
                this.promptTemplates,
              )
            : createCommandSubmit(
                this.state.value,
                paletteState.kind === "command"
                  ? (selected as PromptCommand | undefined)
                  : undefined,
              );
      return submit && this.withImages(submit);
    } catch (error) {
      this.onError?.(error);
      return undefined;
    }
  }

  private withImages(submit: PromptSubmit): PromptSubmit {
    return submit.type === "message" && this.images.length > 0
      ? { ...submit, images: [...this.images] }
      : submit;
  }

  private moveVertically(direction: -1 | 1): boolean {
    const moved = moveCursorVertically(
      this.state,
      {
        columns: this.inputColumns,
        visibleLines: this.inputVisibleLines,
        startLine: this.inputViewportStartLine,
      },
      direction,
    );
    if (!moved) {
      return false;
    }
    this.state = moved.state;
    this.inputViewportStartLine = moved.startLine;
    this.syncPaletteSelection();
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
    this.syncPaletteSelection();

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
        collapsedPastes: [...entry.collapsedPastes],
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

  private getPaletteState(): EditorPaletteState {
    const commandState = getCommandState(this.state.value);
    if (commandState.isCommandMode) {
      return { kind: "command", ...commandState };
    }
    const templateState = getPromptTemplateState(this.state.value, this.promptTemplates);
    if (templateState.isTemplateMode) {
      return { kind: "template", ...templateState };
    }
    const skillState = getSkillReferenceState(this.state.value, this.skills);
    if (skillState.isSkillMode) {
      return { kind: "skill", ...skillState };
    }
    return {
      kind: "none",
      isCommandMode: false,
      showPalette: false,
      query: "",
      suggestions: [],
    };
  }

  private syncPaletteSelection(): void {
    const paletteState = this.getPaletteState();
    const paletteKey = `${paletteState.kind}:${paletteState.query}`;

    if (paletteKey !== this.lastPaletteKey) {
      this.paletteViewport.moveTo(0, paletteState.suggestions.length);
      this.lastPaletteKey = paletteKey;
      return;
    }

    this.paletteViewport.moveTo(
      this.paletteViewport.selectedIndex,
      paletteState.suggestions.length,
    );
  }
}

// reserve one detail row for the overflow marker, and never assume extra space.
function formatImageSummary(images: UserImage[]): string {
  const dimensions = images
    .slice(0, 3)
    .map((image) => `${image.width}×${image.height}`)
    .join(", ");
  const remaining = images.length > 3 ? `, +${images.length - 3}` : "";
  const totalBytes = images.reduce((total, image) => total + base64ByteLength(image.data), 0);
  return `Images · ${images.length} · ${dimensions}${remaining} · ${formatByteSize(totalBytes)}`;
}

function specialInputTokenEnd(value: string): number | undefined {
  if (!value.startsWith("/") && !value.startsWith(":") && !value.startsWith("@")) {
    return undefined;
  }

  const match = /^[/:@]\S*/.exec(value);
  return match?.[0].length;
}
