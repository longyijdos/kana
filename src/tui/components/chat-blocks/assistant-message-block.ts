import type { AssistantMessage } from "@/core";
import { color, dim } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { type Clock, ElapsedTimer } from "../../utils/elapsed-timer";
import { HostedToolBlock } from "./hosted-tool-block";
import { MarkdownBlock } from "./markdown-block";

type AssistantMessageBlockUpdateOptions = {
  complete?: boolean;
};

export class AssistantMessageBlock implements Component {
  private thinkingVisible = false;
  private contentBlocks: (HostedToolBlock | MarkdownBlock)[] = [];
  private readonly hostedToolBlocks = new Map<string, HostedToolBlock>();
  private readonly thinkingTimer: ElapsedTimer;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private cachedThinkingElapsedSeconds?: number;

  constructor(private readonly now: Clock = Date.now) {
    this.thinkingTimer = new ElapsedTimer(now);
  }

  update(message: AssistantMessage, options: AssistantMessageBlockUpdateOptions = {}): void {
    const contentBlocks: (HostedToolBlock | MarkdownBlock)[] = [];
    const hostedToolIds = new Set<string>();
    const messageComplete = options.complete ?? true;

    for (const [index, content] of message.content.entries()) {
      if (content.type === "text" && content.text.trim()) {
        // Ordered content before the live tail is immutable even while the
        // overall assistant message continues with a tool call or another block.
        const blockComplete = messageComplete || index < message.content.length - 1;
        contentBlocks.push(
          new MarkdownBlock(content.text.trim(), {
            complete: blockComplete,
            trailingLineComplete: blockComplete || /(?:\r\n|\r|\n)\s*$/.test(content.text),
          }),
        );
      } else if (content.type === "hosted_tool") {
        hostedToolIds.add(content.id);
        let block = this.hostedToolBlocks.get(content.id);
        if (block) {
          block.update(content);
        } else {
          block = new HostedToolBlock(content, this.now);
          this.hostedToolBlocks.set(content.id, block);
        }
        contentBlocks.push(block);
      }
    }

    for (const [id, block] of this.hostedToolBlocks) {
      if (!hostedToolIds.has(id)) {
        block.stopTimer();
        this.hostedToolBlocks.delete(id);
      }
    }
    this.contentBlocks = contentBlocks;

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

  hasActiveHostedTools(): boolean {
    return [...this.hostedToolBlocks.values()].some((block) => block.hasActiveTimer());
  }

  stopActivityTimers(): void {
    this.showThinking(false);
    for (const block of this.hostedToolBlocks.values()) {
      block.stopTimer();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedThinkingElapsedSeconds = undefined;

    for (const block of this.contentBlocks) {
      block.invalidate();
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const thinkingElapsedSeconds = this.thinkingVisible
      ? this.thinkingTimer.elapsedSeconds()
      : undefined;
    const hasActiveHostedTools = this.hasActiveHostedTools();

    if (
      this.cachedLines &&
      !hasActiveHostedTools &&
      this.cachedWidth === width &&
      this.cachedThinkingElapsedSeconds === thinkingElapsedSeconds
    ) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    let hasRenderedContentBlock = false;

    for (const block of this.contentBlocks) {
      const blockLines = block.render(width, availableHeight);
      if (blockLines.length === 0) {
        continue;
      }
      // Hosted tools and text share one assistant component so they retain
      // provider order. Mirror Transcript spacing at this internal boundary.
      if (hasRenderedContentBlock) {
        lines.push("");
      }
      lines.push(...blockLines);
      hasRenderedContentBlock = true;
    }

    if (this.thinkingVisible && this.contentBlocks.length === 0) {
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
