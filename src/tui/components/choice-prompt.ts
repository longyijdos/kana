import { type Color, color, dim, mapLines, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isLeft, isRight, isUp } from "../runtime";
import { tuiTheme } from "../theme";

export type ChoicePromptOption<T extends string> = {
  value: T;
  label: string;
};

export type ChoicePromptOptions<T extends string> = {
  title: string;
  detail?: string;
  options: ChoicePromptOption<T>[];
  defaultValue: T;
  accentColor?: Color;
  onSelect: (value: T) => void;
};

export class ChoicePrompt<T extends string> implements Component {
  private selectedIndex: number;

  constructor(private readonly options: ChoicePromptOptions<T>) {
    this.selectedIndex = Math.max(
      0,
      options.options.findIndex((option) => option.value === options.defaultValue),
    );
  }

  render(width: number): string[] {
    const accentColor = this.options.accentColor ?? tuiTheme.toolActive;
    const lines = [
      "",
      ...mapLines(this.options.title, (line) => color(line, accentColor)),
      ...(this.options.detail ? mapLines(this.options.detail, dim) : []),
      ...this.options.options.map((option, index) => this.renderOption(option, index, accentColor)),
    ];

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (isUp(data) || isLeft(data)) {
      this.move(-1);
      return;
    }

    if (isDown(data) || isRight(data)) {
      this.move(1);
      return;
    }

    if (isEnter(data)) {
      const option = this.options.options[this.selectedIndex];

      if (option) {
        this.options.onSelect(option.value);
      }
    }
  }

  private move(delta: number): void {
    if (this.options.options.length === 0) {
      return;
    }

    this.selectedIndex =
      (this.selectedIndex + delta + this.options.options.length) % this.options.options.length;
  }

  private renderOption(option: ChoicePromptOption<T>, index: number, accentColor: Color): string {
    const selected = index === this.selectedIndex;
    const line = `${selected ? "> " : "  "}${option.label}`;

    return selected ? color(line, accentColor) : line;
  }
}
