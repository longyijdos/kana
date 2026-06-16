import type { ToolCallContent } from "@/core";
import { color } from "../../render";
import { mapLines } from "../../render";
import { truncateToWidth } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { TextBlock } from "./text-block";
import { formatToolOutput, formatToolTitle, type ToolState } from "../../tools";

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
      ...mapLines(formatToolTitle(this.toolCall, state, this.result), (line) =>
        color(line, titleColor),
      ),
    ];
    const output = formatToolOutput(this.toolCall, this.result ?? this.partialResult, this.isError);

    if (typeof output === "string" && output) {
      lines.push(
        ...new TextBlock(output, {
          color: this.isError ? tuiTheme.error : tuiTheme.toolOutput,
        }).render(width),
      );
    } else if (Array.isArray(output)) {
      lines.push(...output);
    }

    const rendered = lines.map((line) => truncateToWidth(line, width, ""));

    this.cachedWidth = width;
    this.cachedVersion = this.renderVersion;
    this.cachedLines = rendered;

    return rendered;
  }

  private currentState(): ToolState {
    if (this.hasResult) {
      return this.isError ? "failed" : "done";
    }

    return this.executionStarted ? "running" : "preparing";
  }
}
