import type { KanaSessionMetadata } from "@/kana";
import { isEscape } from "../runtime";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";
import { ChoicePrompt } from "./choice-prompt";

export class DeleteSessionConfirmation implements Component {
  private readonly prompt: ChoicePrompt<"yes" | "no">;

  constructor(
    session: KanaSessionMetadata,
    private readonly finish: (confirmed: boolean) => void,
  ) {
    const title = session.title || session.id;

    this.prompt = new ChoicePrompt({
      title: "Delete session?",
      detail: `${title}  ${session.id}`,
      options: [
        { value: "no", label: "No, keep it" },
        { value: "yes", label: "Yes, delete" },
      ],
      defaultValue: "no",
      accentColor: tuiTheme.error,
      onSelect: (decision) => finish(decision === "yes"),
    });
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.finish(false);
      return;
    }

    this.prompt.handleInput(data);
  }

  render(width: number): string[] {
    return this.prompt.render(width);
  }
}
