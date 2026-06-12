import type { ToolCallContent } from "@/core";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";
import { formatToolApproval } from "../tools";
import { ChoicePrompt } from "./choice-prompt";

export type ToolApprovalDecision = "yes" | "no";

export class ToolApproval implements Component {
  private readonly prompt: ChoicePrompt<ToolApprovalDecision>;

  constructor(
    toolCall: ToolCallContent,
    onDecision: (decision: ToolApprovalDecision) => void,
  ) {
    const text = formatToolApproval(toolCall);

    this.prompt = new ChoicePrompt({
      title: text.title,
      detail: text.detail,
      options: [
        { value: "yes", label: "Yes, run it" },
        { value: "no", label: "No, abort" },
      ],
      defaultValue: "yes",
      accentColor: tuiTheme.toolActive,
      onSelect: onDecision,
    });
  }

  render(width: number): string[] {
    return this.prompt.render(width);
  }

  handleInput(data: string): void {
    this.prompt.handleInput(data);
  }
}
