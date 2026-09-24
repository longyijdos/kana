import type { ToolCallContent } from "@/core";
import { stripTerminalControlSequences } from "../render";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";
import { formatToolApproval, highlightOverwriteMarker, type ToolApprovalSource } from "../tools";
import { ChoicePrompt } from "./choice-prompt";

export type ToolApprovalDecision = "yes" | "always" | "no";

export type ToolApprovalOptions = {
  allowAlways?: boolean;
  source?: ToolApprovalSource;
  requesterName?: string;
};

export class ToolApproval implements Component {
  private readonly prompt: ChoicePrompt<ToolApprovalDecision>;

  constructor(
    toolCall: ToolCallContent,
    onDecision: (decision: ToolApprovalDecision) => void,
    options: ToolApprovalOptions = {},
  ) {
    const userTask = toolCall.name === "delegate_user_task";
    const text = userTask
      ? {
          title: "Kana has a task for you",
          detail: readUserTaskDescription(toolCall.args),
        }
      : formatToolApproval(toolCall, options.source, options.requesterName);

    this.prompt = new ChoicePrompt({
      title: text.title,
      detail: text.detail,
      dimDetail: !userTask,
      options: userTask
        ? [
            { value: "yes" as const, label: "Accept task" },
            { value: "no" as const, label: "Let Kana handle it" },
          ]
        : createOptions(options),
      defaultValue: userTask ? "no" : "yes",
      titleColor: userTask ? tuiTheme.user : tuiTheme.toolActive,
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

function readUserTaskDescription(args: unknown): string {
  if (typeof args !== "object" || args === null || !("task" in args)) return "";
  return typeof args.task === "string" ? stripTerminalControlSequences(args.task) : "";
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
