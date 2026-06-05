import { color, dim } from "../render/ansi";
import {
  completeCommand,
  createCommandSubmit,
  getCommandState,
  type PromptSubmit,
} from "./commands";
import type { Component } from "../runtime/component";
import { CURSOR_MARKER } from "../runtime/cursor";
import {
  applyEditorAction,
  firstGrapheme,
  type EditorTextState,
} from "./state";
import { createInputLayout, type InputLayoutLine } from "./input-layout";
import {
  isBackspace,
  isDelete,
  isDown,
  isEnd,
  isEnter,
  isHome,
  isLeft,
  isPrintable,
  isRight,
  isTab,
  isUp,
} from "../runtime/keys";
import { renderCursorText } from "../components/text-block";
import { padRightAnsi, truncateToWidth } from "../render/width";

const MAX_INPUT_LINES = 5;
const PROMPT = "> ";
const CONTINUATION_PROMPT = "  ";

export class Editor implements Component {
  private state: EditorTextState = {
    value: "",
    cursorOffset: 0,
  };
  private history: string[] = [];
  private historyIndex = -1;
  private selectedCommandIndex = 0;
  private lastCommandQuery = "";
  private pasteBuffer = "";
  private isPasting = false;

  onSubmit?: (submit: PromptSubmit) => void;

  getText(): string {
    return this.state.value;
  }

  setText(value: string): void {
    this.state = {
      value,
      cursorOffset: value.length,
    };
    this.historyIndex = -1;
    this.syncCommandSelection();
  }

  clear(): void {
    this.setText("");
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

  render(width: number): string[] {
    const frameWidth = Math.max(width, 8);
    const contentWidth = Math.max(1, frameWidth - 4);
    const inputColumns = Math.max(1, contentWidth - PROMPT.length);
    const layout = createInputLayout({
      value: this.state.value,
      cursorOffset: this.state.cursorOffset,
      columns: inputColumns,
      maxLines: MAX_INPUT_LINES,
    });
    const lines = [`+${"-".repeat(frameWidth - 2)}+`];

    for (const [index, line] of layout.lines.entries()) {
      const prompt = index === 0 ? PROMPT : CONTINUATION_PROMPT;
      const input = this.renderLine(line);
      const content = `${color(prompt, "yellow")}${input}`;

      lines.push(`| ${padRightAnsi(content, contentWidth)} |`);
    }

    lines.push(`+${"-".repeat(frameWidth - 2)}+`);
    lines.push(...this.renderCommandPalette(frameWidth));

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    const paste = this.consumePaste(data);

    if (paste !== undefined) {
      if (paste) {
        this.applyText(paste);
      }
      return;
    }

    if (isEnter(data)) {
      const commandState = getCommandState(this.state.value);
      const submit = createCommandSubmit(
        this.state.value,
        commandState.suggestions[this.selectedCommandIndex],
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
        this.selectedCommandIndex = wrapIndex(
          this.selectedCommandIndex + (isUp(data) ? -1 : 1),
          commandState.suggestions.length,
        );
        return;
      }

      this.navigateHistory(isUp(data) ? 1 : -1);
      return;
    }

    if (isTab(data)) {
      const commandState = getCommandState(this.state.value);
      const command = commandState.suggestions[this.selectedCommandIndex];

      if (commandState.showPalette && command) {
        this.setText(completeCommand(command));
      }
      return;
    }

    if (isPrintable(data)) {
      this.applyText(data);
    }
  }

  private renderLine(line: InputLayoutLine): string {
    if (!this.state.value) {
      return renderCursorText(CURSOR_MARKER, " ", dim("Ask the agent..."));
    }

    if (
      this.state.cursorOffset < line.startOffset ||
      this.state.cursorOffset > line.endOffset
    ) {
      return line.text;
    }

    const relativeOffset = this.state.cursorOffset - line.startOffset;
    const beforeCursor = line.text.slice(0, relativeOffset);
    const afterCursor = line.text.slice(relativeOffset);
    const cursorText = firstGrapheme(afterCursor) ?? " ";
    const restAfterCursor =
      cursorText === " " && !afterCursor ? "" : afterCursor.slice(cursorText.length);

    return renderCursorText(`${beforeCursor}${CURSOR_MARKER}`, cursorText, restAfterCursor);
  }

  private renderCommandPalette(width: number): string[] {
    const commandState = getCommandState(this.state.value);

    if (!commandState.showPalette) {
      return [];
    }

    if (commandState.suggestions.length === 0) {
      return [color("No matching commands", "red")];
    }

    return commandState.suggestions.map((command, index) => {
      const prefix = index === this.selectedCommandIndex ? "> " : "  ";
      const line = `${prefix}/${command.name.padEnd(8)} ${command.description}`;

      return index === this.selectedCommandIndex
        ? color(truncateToWidth(line, width, ""), "yellow")
        : truncateToWidth(line, width, "");
    });
  }

  private applyText(text: string): void {
    this.applyAction({
      type: "insert",
      text,
    });
    this.historyIndex = -1;
  }

  private applyAction(action: Parameters<typeof applyEditorAction>[1]): void {
    this.state = applyEditorAction(this.state, action);
    this.syncCommandSelection();
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
      this.selectedCommandIndex = 0;
      this.lastCommandQuery = commandState.query;
    }

    this.selectedCommandIndex = Math.min(
      this.selectedCommandIndex,
      Math.max(commandState.suggestions.length - 1, 0),
    );
  }

  private consumePaste(data: string): string | undefined {
    if (data.includes("\x1b[200~")) {
      this.isPasting = true;
      this.pasteBuffer = "";
      data = data.replace("\x1b[200~", "");
    }

    if (!this.isPasting) {
      return undefined;
    }

    this.pasteBuffer += data;
    const endIndex = this.pasteBuffer.indexOf("\x1b[201~");

    if (endIndex === -1) {
      return "";
    }

    const pasted = this.pasteBuffer.slice(0, endIndex);
    const remaining = this.pasteBuffer.slice(endIndex + "\x1b[201~".length);
    this.isPasting = false;
    this.pasteBuffer = "";

    if (remaining) {
      queueMicrotask(() => this.handleInput(remaining));
    }

    return pasted;
  }
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}
