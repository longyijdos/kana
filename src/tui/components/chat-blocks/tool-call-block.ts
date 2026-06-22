import type { ToolCallContent } from "@/core";
import { bold, color, truncateToWidth, visibleWidth, wrapPlainText } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import {
  formatToolOutput,
  formatToolTitle,
  formatToolTranscriptTitle,
  hasExpandableToolOutput,
  type ToolOutputDetail,
  type ToolState,
} from "../../tools";
import type { ContentView } from "../content-viewer";

export class ToolCallBlock implements Component {
  private executionStarted = false;
  private result?: unknown;
  private partialResult?: unknown;
  private hasResult = false;
  private isError = false;
  private renderVersion = 0;
  private cachedWidth?: number;
  private cachedVersion?: number;
  private cachedLines?: string[];
  private outputHintVisible = false;

  constructor(private readonly toolCall: ToolCallContent) {}

  updateArgs(args: unknown): void {
    this.toolCall.args = args;
    this.invalidate();
  }

  markExecutionStarted(): void {
    this.executionStarted = true;
    this.invalidate();
  }

  updatePartialResult(result: unknown): void {
    this.partialResult = result;
    this.invalidate();
  }

  updateResult(result: unknown, isError: boolean): void {
    this.result = result;
    this.hasResult = true;
    this.isError = isError;
    this.partialResult = undefined;
    this.invalidate();
  }

  invalidate(): void {
    this.renderVersion += 1;
    this.cachedWidth = undefined;
    this.cachedVersion = undefined;
    this.cachedLines = undefined;
  }

  setOutputHintVisible(visible: boolean): void {
    if (this.outputHintVisible === visible) {
      return;
    }

    this.outputHintVisible = visible;
    this.invalidate();
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedVersion === this.renderVersion
    ) {
      return this.cachedLines;
    }

    const state = this.currentState();
    const titleColor = this.isError
      ? tuiTheme.error
      : state === "done"
        ? tuiTheme.toolSuccess
        : tuiTheme.toolActive;
    const lines = ["", ...this.renderTitle(width, titleColor)];
    lines.push(...this.renderOutput(width, "compact"));
    lines.push("");

    const rendered = lines.map((line) => truncateToWidth(line, width));

    this.cachedWidth = width;
    this.cachedVersion = this.renderVersion;
    this.cachedLines = rendered;

    return rendered;
  }

  getResultView(): ContentView | undefined {
    if (!this.hasInspectableOutput() || this.toolCall.name === "read") {
      return undefined;
    }

    return {
      title: formatToolTitle(this.toolCall, this.currentState(), this.result),
      render: (width) => this.renderOutput(width, "full"),
    };
  }

  hasExpandableOutput(): boolean {
    if (!this.hasInspectableOutput()) {
      return false;
    }

    return hasExpandableToolOutput(this.toolCall, this.result ?? this.partialResult, this.isError);
  }

  private currentState(): ToolState {
    if (this.hasResult) {
      return this.isError ? "failed" : "done";
    }

    return this.executionStarted ? "running" : "preparing";
  }

  private hasInspectableOutput(): boolean {
    return this.hasResult || this.partialResult !== undefined;
  }

  private renderOutput(width: number, detail: ToolOutputDetail): string[] {
    const output = formatToolOutput(
      this.toolCall,
      this.result ?? this.partialResult,
      this.isError,
      detail,
      width,
    );
    return output;
  }

  private renderTitle(width: number, titleColor: Parameters<typeof color>[1]): string[] {
    const title = formatToolTranscriptTitle(this.toolCall, this.currentState(), this.result, {
      showOutputHint: this.outputHintVisible,
    });
    const lines = [colorTitleWithShortcutHint(`◆ ${title.activity}`, title.hint, titleColor)];
    const prefix = "  └ ";
    const continuationPrefix = " ".repeat(visibleWidth(prefix));

    if (title.target) {
      for (const [index, line] of wrapPlainText(
        title.target,
        Math.max(1, width - visibleWidth(prefix)),
      ).entries()) {
        lines.push(`${index === 0 ? prefix : continuationPrefix}${line}`);
      }
    }

    return lines;
  }
}

function colorTitleWithShortcutHint(
  activity: string,
  hint: string | undefined,
  titleColor: Parameters<typeof color>[1],
): string {
  return `${bold(color(activity, titleColor))}${hint ? color(` (${hint})`, tuiTheme.shortcutHint) : ""}`;
}
