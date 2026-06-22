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
import { highlightCodeSync, inferCodeLanguage } from "../../utils/syntax-highlighter";
import type { ContentView } from "../content-viewer";
import { styleSpans, wrapSpans } from "./markdown-inline";
import { TextBlock } from "./text-block";

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

    const rendered = lines.map((line) => truncateToWidth(line, width));

    this.cachedWidth = width;
    this.cachedVersion = this.renderVersion;
    this.cachedLines = rendered;

    return rendered;
  }

  getResultView(): ContentView | undefined {
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
      const highlighted = this.renderHighlightedFileOutput(output, width);
      if (highlighted) {
        return highlighted;
      }

      return new TextBlock(output, {
        color: this.isError ? tuiTheme.error : tuiTheme.toolOutput,
      }).render(width);
    }

    return Array.isArray(output) ? output : [];
  }

  private renderHighlightedFileOutput(output: string, width: number): string[] | undefined {
    if (this.toolCall.name !== "read" && this.toolCall.name !== "write") {
      return undefined;
    }

    const path =
      typeof this.toolCall.args === "object" && this.toolCall.args
        ? (this.toolCall.args as { path?: unknown }).path
        : undefined;
    const language = inferCodeLanguage(typeof path === "string" ? path : undefined);
    const highlighted = highlightCodeSync(output.substring(output.indexOf("\n") + 1), language);

    if (!language || !highlighted || !output.includes("\n")) {
      return undefined;
    }

    const header = output.slice(0, output.indexOf("\n"));
    const lines = new TextBlock(header, { color: tuiTheme.toolOutput }).render(width);

    for (const codeLine of highlighted) {
      const spans = codeLine.map((token) => ({
        text: token.text.replace(/\t/g, "   "),
        style: token.color ? { color: token.color } : undefined,
      }));
      for (const wrapped of wrapSpans(spans, width, width)) {
        lines.push(styleSpans(wrapped, { defaultColor: tuiTheme.toolOutput }));
      }
    }

    return lines;
  }

  private renderTitle(width: number, titleColor: Parameters<typeof color>[1]): string[] {
    const title = formatToolTranscriptTitle(this.toolCall, this.currentState(), this.result, {
      showOutputHint: this.outputHintVisible,
    });
    const lines = [colorTitleWithShortcutHint(`◆ ${title.activity}`, title.hint, titleColor)];
    const prefix = "  └ ";
    const continuationPrefix = " ".repeat(visibleWidth(prefix));

    for (const [index, line] of wrapPlainText(
      title.target,
      Math.max(1, width - visibleWidth(prefix)),
    ).entries()) {
      lines.push(`${index === 0 ? prefix : continuationPrefix}${line}`);
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
