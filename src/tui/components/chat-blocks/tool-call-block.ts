import type { ToolCallContent } from "../../../core/messages";
import { color } from "../../render/ansi";
import { splitLines } from "../../render/lines";
import { truncateToWidth } from "../../render/width";
import type { Component } from "../../runtime/component";
import { tuiTheme } from "../../theme";
import { TextBlock } from "./text-block";
import {
  formatToolOutput,
  formatToolTitle,
  type ToolState,
} from "./tool-renderers";

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
      ...renderTitle(formatToolTitle(this.toolCall, state, this.result), titleColor),
    ];
    const output = formatToolOutput(
      this.toolCall,
      this.result ?? this.partialResult,
      this.isError,
    );

    if (typeof output === "string" && output) {
      lines.push(
        ...renderOutput(
          output,
          width,
          this.isError ? tuiTheme.error : tuiTheme.toolOutput,
        ),
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

function renderTitle(
  title: string,
  titleColor: Parameters<typeof color>[1],
): string[] {
  return splitLines(title).map((line) => color(line, titleColor));
}

function renderOutput(
  output: string,
  width: number,
  outputColor: Parameters<typeof color>[1],
): string[] {
  return new TextBlock(output, {
    color: outputColor,
  }).render(width);
}
