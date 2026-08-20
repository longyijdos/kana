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

type AssistantMessageBlockOptions = {
  hyperlinks?: boolean;
  renderLatex?: boolean;
  renderMermaid?: boolean;
};

export class AssistantMessageBlock implements Component {
  private workingVisible = false;
  private contentBlocks: (HostedToolBlock | MarkdownBlock)[] = [];
  private readonly hostedToolBlocks = new Map<string, HostedToolBlock>();
  private readonly workingTimer: ElapsedTimer;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private cachedWorkingElapsedSeconds?: number;

  constructor(
    private readonly now: Clock = Date.now,
    private readonly options: AssistantMessageBlockOptions = {},
  ) {
    this.workingTimer = new ElapsedTimer(now);
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
            hyperlinks: this.options.hyperlinks,
            renderLatex: this.options.renderLatex,
            renderMermaid: this.options.renderMermaid,
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

  showWorking(value: boolean): void {
    if (this.workingVisible === value) {
      return;
    }

    this.workingVisible = value;
    if (value) {
      this.workingTimer.start();
    } else {
      this.workingTimer.stop();
    }
    this.invalidate();
  }

  isWorking(): boolean {
    return this.workingVisible;
  }

  hasActiveHostedTools(): boolean {
    return [...this.hostedToolBlocks.values()].some((block) => block.hasActiveTimer());
  }

  stopActivityTimers(): void {
    this.showWorking(false);
    for (const block of this.hostedToolBlocks.values()) {
      block.stopTimer();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedWorkingElapsedSeconds = undefined;

    for (const block of this.contentBlocks) {
      block.invalidate();
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const workingElapsedSeconds = this.workingVisible
      ? this.workingTimer.elapsedSeconds()
      : undefined;
    const hasActiveHostedTools = this.hasActiveHostedTools();

    if (
      this.cachedLines &&
      !hasActiveHostedTools &&
      this.cachedWidth === width &&
      this.cachedWorkingElapsedSeconds === workingElapsedSeconds
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

    if (this.workingVisible) {
      if (hasRenderedContentBlock) {
        lines.push("");
      }
      lines.push(
        `${dim(`working (${workingElapsedSeconds}s)`)}` +
          color(" (Esc to abort)", tuiTheme.shortcutHint),
      );
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    this.cachedWorkingElapsedSeconds = workingElapsedSeconds;

    return lines;
  }
}
