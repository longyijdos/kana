import type { AssistantMessage } from "@/core";
import { color, dim } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { type Clock, ElapsedTimer } from "../../utils/elapsed-timer";
import { MarkdownBlock } from "./markdown-block";

type AssistantMessageBlockUpdateOptions = {
  complete?: boolean;
};

export class AssistantMessageBlock implements Component {
  private thinkingVisible = false;
  private textBlocks: MarkdownBlock[] = [];
  private readonly thinkingTimer: ElapsedTimer;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private cachedThinkingElapsedSeconds?: number;

  constructor(now: Clock = Date.now) {
    this.thinkingTimer = new ElapsedTimer(now);
  }

  update(message: AssistantMessage, options: AssistantMessageBlockUpdateOptions = {}): void {
    this.textBlocks = [];
    const messageComplete = options.complete ?? true;

    for (const [index, content] of message.content.entries()) {
      if (content.type === "text" && content.text.trim()) {
        // Ordered content before the live tail is immutable even while the
        // overall assistant message continues with a tool call or another block.
        const blockComplete = messageComplete || index < message.content.length - 1;
        this.textBlocks.push(
          new MarkdownBlock(content.text.trim(), {
            complete: blockComplete,
            trailingLineComplete: blockComplete || /(?:\r\n|\r|\n)\s*$/.test(content.text),
          }),
        );
      }
    }

    this.invalidate();
  }

  showThinking(value: boolean): void {
    if (this.thinkingVisible === value) {
      return;
    }

    this.thinkingVisible = value;
    if (value) {
      this.thinkingTimer.start();
    } else {
      this.thinkingTimer.stop();
    }
    this.invalidate();
  }

  isThinking(): boolean {
    return this.thinkingVisible;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedThinkingElapsedSeconds = undefined;

    for (const block of this.textBlocks) {
      block.invalidate();
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const thinkingElapsedSeconds = this.thinkingVisible
      ? this.thinkingTimer.elapsedSeconds()
      : undefined;

    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedThinkingElapsedSeconds === thinkingElapsedSeconds
    ) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    for (const block of this.textBlocks) {
      lines.push(...block.render(width, availableHeight));
    }

    if (this.thinkingVisible && this.textBlocks.length === 0) {
      lines.push(
        `${dim(`thinking (${thinkingElapsedSeconds}s)`)}` +
          color(" (Esc to abort)", tuiTheme.shortcutHint),
      );
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    this.cachedThinkingElapsedSeconds = thinkingElapsedSeconds;

    return lines;
  }
}
