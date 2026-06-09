import type { ToolCallContent } from "../../core/messages";
import { color, dim } from "../render/ansi";
import { truncateToWidth } from "../render/width";
import type { Component } from "../runtime/component";
import { tuiTheme } from "../theme";
import { formatToolApprovalTitle } from "./chat-blocks/tool-renderers";
import {
  getNumberProperty,
  getStringProperty,
  toolTarget,
} from "./chat-blocks/tool-renderers/shared";
import {
  isDown,
  isEnter,
  isLeft,
  isRight,
  isUp,
} from "../runtime/keys";

export type ToolApprovalDecision = "yes" | "no";

export class ToolApproval implements Component {
  private selected: ToolApprovalDecision = "yes";

  constructor(
    private readonly toolCall: ToolCallContent,
    private readonly onDecision: (decision: ToolApprovalDecision) => void,
  ) {}

  render(width: number): string[] {
    const lines = [
      "",
      color(formatToolApprovalTitle(this.toolCall), tuiTheme.toolActive),
      dim(formatToolDetail(this.toolCall)),
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

function formatToolDetail(toolCall: ToolCallContent): string {
  const target = toolTarget(toolCall);
  const summary = formatToolSummary(toolCall);

  return summary ? `${target} - ${summary}` : target;
}

function formatToolSummary(toolCall: ToolCallContent): string {
  switch (toolCall.name) {
    case "read": {
      const startLine = getNumberProperty(toolCall.args, "startLine");
      const endLine = getNumberProperty(toolCall.args, "endLine");

      return startLine !== undefined || endLine !== undefined
        ? `lines ${startLine ?? "start"}-${endLine ?? "end"}`
        : "";
    }

    case "write": {
      const content = getStringProperty(toolCall.args, "content");

      return content ? summarizeText(content) : "";
    }

    case "edit": {
      const oldText = getStringProperty(toolCall.args, "oldText");

      return oldText ? `replace ${summarizeText(oldText)}` : "";
    }

    case "bash": {
      const cwd = getStringProperty(toolCall.args, "cwd");

      return cwd ? `cwd ${cwd}` : "";
    }
  }

  if (toolCall.args === undefined) {
    return "";
  }

  try {
    return JSON.stringify(toolCall.args);
  } catch {
    return String(toolCall.args);
  }
}

function summarizeText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}
