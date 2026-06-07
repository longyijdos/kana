import { color, dim, inverse } from "../render/ansi";
import type { Component } from "../runtime/component";
import { truncateToWidth, visibleWidth, wrapPlainText } from "../render/width";

export class TextBlock implements Component {
  constructor(
    private text: string,
    private readonly options: {
      color?: Parameters<typeof color>[1];
      dim?: boolean;
      paddingTop?: number;
      prefix?: string;
    } = {},
  ) {}

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const prefix = this.options.prefix ?? "";
    const contentWidth = Math.max(1, width - visibleWidth(prefix));

    for (let index = 0; index < (this.options.paddingTop ?? 0); index += 1) {
      lines.push("");
    }

    for (const [index, line] of wrapPlainText(this.text, contentWidth).entries()) {
      const styled = style(`${index === 0 ? prefix : ""}${line}`, this.options);
      lines.push(truncateToWidth(styled, width, ""));
    }

    return lines.length ? lines : [""];
  }
}

export function renderCursorText(
  beforeCursor: string,
  cursorText: string,
  afterCursor: string,
): string {
  return `${beforeCursor}${inverse(cursorText)}${afterCursor}`;
}

function style(
  text: string,
  options: {
    color?: Parameters<typeof color>[1];
    dim?: boolean;
  },
): string {
  let next = text;

  if (options.color) {
    next = color(next, options.color);
  }

  if (options.dim) {
    next = dim(next);
  }

  return next;
}
