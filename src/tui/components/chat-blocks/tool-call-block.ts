import type { ToolCallContent } from "@/core";
import { color } from "../../render";
import { mapLines } from "../../render";
import { truncateToWidth } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { TextBlock } from "./text-block";
import {
  formatToolOutput,
  formatToolTitle,
  type ToolState,
} from "../../tools";

export class ToolCallBlock implements Component {
  private executionStarted = false;
  private result?: unknown;
  private partialResult?: unknown;
  private hasResult = false;
  private isError = false;

  constructor(private readonly toolCall: ToolCallContent) {}

  updateArgs(args: unknown): void {
    this.toolCall.args = args;
  }

  markExecutionStarted(): void {
    this.executionStarted = true;
  }

  updatePartialResult(result: unknown): void {
    this.partialResult = result;
  }

  updateResult(result: unknown, isError: boolean): void {
    this.result = result;
    this.hasResult = true;
    this.isError = isError;
    this.partialResult = undefined;
  }

  render(width: number): string[] {
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
    const output = formatToolOutput(
      this.toolCall,
      this.result ?? this.partialResult,
      this.isError,
    );

    if (typeof output === "string" && output) {
      lines.push(
        ...new TextBlock(output, {
          color: this.isError ? tuiTheme.error : tuiTheme.toolOutput,
        }).render(width),
      );
    } else if (Array.isArray(output)) {
      lines.push(...output);
    }

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private currentState(): ToolState {
    if (this.hasResult) {
      return this.isError ? "failed" : "done";
    }

    return this.executionStarted ? "running" : "preparing";
  }
}
