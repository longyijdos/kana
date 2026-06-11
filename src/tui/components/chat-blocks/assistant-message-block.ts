import type { AssistantMessage } from "@/core";
import { dim } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { TextBlock } from "./text-block";

export class AssistantMessageBlock implements Component {
  private message: AssistantMessage = {
    role: "assistant",
    content: [],
  };
  private thinkingVisible = false;

  update(message: AssistantMessage): void {
    this.message = message;
  }

  showThinking(value: boolean): void {
    this.thinkingVisible = value;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    let renderedContent = false;

    for (const content of this.message.content) {
      if (content.type === "text" && content.text.trim()) {
        lines.push(
          ...new TextBlock(content.text.trim(), {
            color: tuiTheme.assistant,
          }).render(width),
        );
        renderedContent = true;
      }
    }

    if (this.thinkingVisible && !renderedContent) {
      lines.push(dim("thinking..."));
    }

    return lines;
  }
}
