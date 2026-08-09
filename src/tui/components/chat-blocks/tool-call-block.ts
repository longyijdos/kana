import type { ToolCallContent } from "@/core";
import { bold, color, truncateToWidth, visibleWidth, wrapPlainText } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import {
  formatToolOutput,
  formatToolTitle,
  formatToolTranscriptTitle,
  hasExpandableToolOutput,
  highlightOverwriteMarker,
  type ToolOutputDetail,
  type ToolState,
} from "../../tools";
import { type Clock, ElapsedTimer } from "../../utils/elapsed-timer";
import type { ContentView } from "../content-viewer";

export class ToolCallBlock implements Component {
  private executionStarted = false;
  private canceled = false;
  private result?: unknown;
  private partialResult?: unknown;
  private hasResult = false;
  private isError = false;
  private readonly phaseTimer: ElapsedTimer;
  private renderVersion = 0;
  private cachedWidth?: number;
  private cachedVersion?: number;
  private cachedElapsedSeconds?: number;
  private cachedLines?: string[];

  constructor(
    private readonly toolCall: ToolCallContent,
    now: Clock = Date.now,
  ) {
    this.phaseTimer = new ElapsedTimer(now);
    this.phaseTimer.start();
  }

  updateArgs(args: unknown): void {
    this.toolCall.args = args;
    this.invalidate();
  }

  markExecutionStarted(): void {
    this.executionStarted = true;
    this.canceled = false;
    this.phaseTimer.start();
    this.invalidate();
  }

  freezePreparation(): void {
    if (this.executionStarted || this.hasResult) {
      return;
    }

    this.phaseTimer.stop();
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
    this.canceled = false;
    this.partialResult = undefined;
    this.phaseTimer.stop();
    this.invalidate();
  }

  stopTimer(): void {
    this.phaseTimer.stop();
  }

  markCanceled(): void {
    if (this.hasResult) {
      return;
    }

    this.canceled = true;
    this.partialResult = undefined;
    this.phaseTimer.stop();
    this.invalidate();
  }

  hasActiveTimer(): boolean {
    return this.phaseTimer.active;
  }

  invalidate(): void {
    this.renderVersion += 1;
    this.cachedWidth = undefined;
    this.cachedVersion = undefined;
    this.cachedElapsedSeconds = undefined;
    this.cachedLines = undefined;
  }

  render(width: number, _availableHeight?: number): string[] {
    const state = this.currentState();
    const elapsedSeconds =
      state === "preparing" || state === "running" ? this.phaseTimer.elapsedSeconds() : undefined;

    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedVersion === this.renderVersion &&
      this.cachedElapsedSeconds === elapsedSeconds
    ) {
      return this.cachedLines;
    }

    const titleColor =
      state === "canceled"
        ? tuiTheme.muted
        : this.isError
          ? tuiTheme.error
          : state === "done"
            ? tuiTheme.toolSuccess
            : tuiTheme.toolActive;
    const lines = this.renderTitle(width, titleColor, elapsedSeconds);
    if (state !== "canceled") {
      lines.push(...this.renderOutput(width, "compact"));
    }

    const rendered = lines.map((line) => truncateToWidth(line, width));

    this.cachedWidth = width;
    this.cachedVersion = this.renderVersion;
    this.cachedElapsedSeconds = elapsedSeconds;
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
      if (isCanceledResult(this.result)) {
        return "canceled";
      }
      return this.isError ? "failed" : "done";
    }

    if (this.canceled) {
      return "canceled";
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

  private renderTitle(
    width: number,
    titleColor: Parameters<typeof color>[1],
    elapsedSeconds: number | undefined,
  ): string[] {
    const title = formatToolTranscriptTitle(
      this.toolCall,
      this.currentState(),
      this.result,
      elapsedSeconds,
    );
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

function isCanceledResult(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }

  const record = result as Record<string, unknown>;
  return (
    record.canceled === true || (record.status === "canceled" && record.reason === "run_aborted")
  );
}

function colorTitleWithShortcutHint(
  activity: string,
  hint: string | undefined,
  titleColor: Parameters<typeof color>[1],
): string {
  return highlightOverwriteMarker(
    `${bold(color(activity, titleColor))}${hint ? color(` (${hint})`, tuiTheme.shortcutHint) : ""}`,
  );
}
