import type { ToolCallContent } from "@/core";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";
import { formatToolApproval, highlightOverwriteMarker, type ToolApprovalSource } from "../tools";
import { ChoicePrompt } from "./choice-prompt";

export type ToolApprovalDecision = "yes" | "always" | "no";

export type ToolApprovalOptions = {
  allowAlways?: boolean;
  source?: ToolApprovalSource;
};

export class ToolApproval implements Component {
  private readonly prompt: ChoicePrompt<ToolApprovalDecision>;

  constructor(
    toolCall: ToolCallContent,
    onDecision: (decision: ToolApprovalDecision) => void,
    options: ToolApprovalOptions = {},
  ) {
    const text = formatToolApproval(toolCall, options.source);

    this.prompt = new ChoicePrompt({
      title: text.title,
      detail: text.detail,
      options: createOptions(options),
      defaultValue: "yes",
      titleColor: tuiTheme.toolActive,
      highlight: highlightOverwriteMarker,
      onSelect: onDecision,
      onCancel: () => onDecision("no"),
    });
  }

  render(width: number, availableHeight?: number): string[] {
    return this.prompt.render(width, availableHeight);
  }

  handleInput(data: string): void {
    this.prompt.handleInput(data);
  }
}

function createOptions(
  options: ToolApprovalOptions,
): Array<{ value: ToolApprovalDecision; label: string }> {
  if (!options.allowAlways) {
    return [
      { value: "yes", label: "Allow once" },
      { value: "no", label: "Deny" },
    ];
  }

  return [
    { value: "yes", label: "Allow once" },
    { value: "always", label: "Always allow this command" },
    { value: "no", label: "Deny" },
  ];
}
