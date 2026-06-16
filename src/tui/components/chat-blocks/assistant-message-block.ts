import type { AssistantMessage } from "@/core";
import { dim } from "../../render";
import type { Component } from "../../runtime";
import { MarkdownBlock } from "./markdown-block";

export class AssistantMessageBlock implements Component {
  private thinkingVisible = false;
  private textBlocks: MarkdownBlock[] = [];
  private cachedWidth?: number;
  private cachedLines?: string[];

  update(message: AssistantMessage): void {
    this.textBlocks = [];

    for (const content of message.content) {
      if (content.type === "text" && content.text.trim()) {
        this.textBlocks.push(new MarkdownBlock(content.text.trim()));
      }
    }

    this.invalidate();
  }

  showThinking(value: boolean): void {
    if (this.thinkingVisible === value) {
      return;
    }

    this.thinkingVisible = value;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;

    for (const block of this.textBlocks) {
      block.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    for (const block of this.textBlocks) {
      lines.push(...block.render(width));
    }

    if (this.thinkingVisible && this.textBlocks.length === 0) {
      lines.push(dim("thinking..."));
    }

    this.cachedWidth = width;
    this.cachedLines = lines;

    return lines;
  }
}
