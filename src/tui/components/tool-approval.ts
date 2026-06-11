import type { ToolCallContent } from "@/core";
import { color, dim } from "../render";
import { mapLines } from "../render";
import { truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";
import { formatToolApproval } from "../tools";
import {
  isDown,
  isEnter,
  isLeft,
  isRight,
  isUp,
} from "../runtime";

export type ToolApprovalDecision = "yes" | "no";

export class ToolApproval implements Component {
  private selected: ToolApprovalDecision = "yes";

  constructor(
    private readonly toolCall: ToolCallContent,
    private readonly onDecision: (decision: ToolApprovalDecision) => void,
  ) {}

  render(width: number): string[] {
    const text = formatToolApproval(this.toolCall);
    const lines = [
      "",
      ...mapLines(text.title, (line) =>
        color(line, tuiTheme.toolActive),
      ),
      ...mapLines(text.detail, dim),
      this.renderOption("yes", "Yes, run it"),
      this.renderOption("no", "No, abort"),
    ];

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (isUp(data) || isDown(data) || isLeft(data) || isRight(data)) {
      this.selected = this.selected === "yes" ? "no" : "yes";
      return;
    }

    if (isEnter(data)) {
      this.onDecision(this.selected);
    }
  }

  private renderOption(value: ToolApprovalDecision, label: string): string {
    const prefix = value === this.selected ? "> " : "  ";
    const line = `${prefix}${label}`;

    return value === this.selected ? color(line, tuiTheme.toolActive) : line;
  }
}
