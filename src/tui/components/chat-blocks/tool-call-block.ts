import type { ToolCallContent } from "@/core";
import { color, mapLines, truncateToWidth } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import {
  formatToolOutput,
  formatToolTitle,
  hasExpandableToolOutput,
  type ToolOutputDetail,
  type ToolState,
} from "../../tools";
import { TextBlock } from "./text-block";

export type ToolResultView = {
  title: string;
  render: (width: number) => string[];
};

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
    const lines = [
      "",
      ...mapLines(
        formatToolTitle(this.toolCall, state, this.result, {
          showOutputHint: this.outputHintVisible,
        }),
        (line) => color(line, titleColor),
      ),
    ];
    lines.push(...this.renderOutput(width, "compact"));

    const rendered = lines.map((line) => truncateToWidth(line, width, ""));

    this.cachedWidth = width;
    this.cachedVersion = this.renderVersion;
    this.cachedLines = rendered;

    return rendered;
  }

  getResultView(): ToolResultView | undefined {
    if (!this.hasInspectableOutput()) {
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
    );

    if (typeof output === "string" && output) {
      return new TextBlock(output, {
        color: this.isError ? tuiTheme.error : tuiTheme.toolOutput,
      }).render(width);
    }

    return Array.isArray(output) ? output : [];
  }
}
