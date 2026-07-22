import { type Color, color, dim, mapLines, truncateToWidth, wrapPlainText } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isLeft, isPageDown, isPageUp, isRight, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

export type ChoicePromptOption<T extends string> = {
  value: T;
  label: string;
};

export type ChoicePromptOptions<T extends string> = {
  title: string;
  detail?: string;
  options: ChoicePromptOption<T>[];
  defaultValue: T;
  titleColor?: Color;
  selectionColor?: Color;
  highlight?: (line: string) => string;
  onSelect: (value: T) => void;
  onCancel?: () => void;
};

export class ChoicePrompt<T extends string> implements Component {
  private selectedIndex: number;
  private readonly detailViewport = new ListViewport(1);
  private detailLength = 0;

  constructor(private readonly options: ChoicePromptOptions<T>) {
    this.selectedIndex = Math.max(
      0,
      options.options.findIndex((option) => option.value === options.defaultValue),
    );
  }

  render(width: number, availableHeight?: number): string[] {
    const titleColor = this.options.titleColor ?? tuiTheme.bottomTitle;
    const selectionColor = this.options.selectionColor ?? tuiTheme.user;
    const highlight = this.options.highlight ?? ((line: string) => line);
    const titleLines = mapLines(this.options.title, (line) => highlight(color(line, titleColor)));
    const detailLines = this.options.detail
      ? wrapPlainText(this.options.detail, width).map((line) => highlight(dim(line)))
      : [];
    const optionLines = this.options.options.map((option, index) =>
      this.renderOption(option, index, selectionColor),
    );
    const lines = [
      ...titleLines,
      ...this.renderDetail(detailLines, availableHeight, titleLines.length + optionLines.length),
      ...optionLines,
    ];

    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (isEscape(data) && this.options.onCancel) {
      this.options.onCancel();
      return;
    }

    if (isPageUp(data) || isLeft(data)) {
      this.detailViewport.page(-1, this.detailLength);
      return;
    }

    if (isPageDown(data) || isRight(data)) {
      this.detailViewport.page(1, this.detailLength);
      return;
    }

    if (isUp(data)) {
      this.move(-1);
      return;
    }

    if (isDown(data)) {
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

  private renderOption(
    option: ChoicePromptOption<T>,
    index: number,
    selectionColor: Color,
  ): string {
    const selected = index === this.selectedIndex;
    const line = `${selected ? "> " : "  "}${option.label}`;

    return selected ? color(line, selectionColor) : line;
  }

  private renderDetail(
    detailLines: string[],
    availableHeight: number | undefined,
    fixedRows: number,
  ): string[] {
    this.detailLength = detailLines.length;

    if (detailLines.length === 0) {
      return [];
    }

    this.detailViewport.setVisibleLimit(
      visibleLimitForHeight(detailLines.length, availableHeight, fixedRows + 3),
      detailLines.length,
    );
    const viewport = this.detailViewport.window(detailLines.length);

    if (viewport.hiddenBefore === 0 && viewport.hiddenAfter === 0) {
      return detailLines;
    }

    return [
      ...(viewport.hiddenBefore > 0
        ? [dim(`... ${viewport.hiddenBefore} detail lines above`)]
        : []),
      ...detailLines.slice(viewport.start, viewport.end),
      ...(viewport.hiddenAfter > 0 ? [dim(`... ${viewport.hiddenAfter} detail lines below`)] : []),
      dim("Left/Right page detail"),
    ];
  }
}
