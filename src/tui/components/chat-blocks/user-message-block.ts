import { createUserMessage, type UserImage, type UserMessage } from "@/core";

import {
  base64ByteLength,
  formatByteSize,
  renderHighlightedLine,
  showControlCharacters,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";

const PREFIX = "> ";

export class UserMessageBlock implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly message: UserMessage;

  constructor(message: UserMessage | string) {
    this.message =
      typeof message === "string"
        ? createUserMessage({ content: message, provenance: { kind: "user_input" } })
        : message;
  }

  render(width: number, _availableHeight?: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const prefixWidth = visibleWidth(PREFIX);
    const messageLines = this.message.content
      ? wrapPlainText(showControlCharacters(this.message.content), width - prefixWidth - 1)
      : [];
    const rows = [
      ...(this.message.images ?? []).map((image, index) => formatImage(image, index)),
      ...messageLines,
    ];
    if (rows.length === 0) {
      rows.push("");
    }
    const separator = "-".repeat(width);
    const lines = [
      separator,
      ...rows.map((line, index) => {
        const rendered = renderHighlightedLine([
          {
            text: index === 0 ? PREFIX : " ".repeat(prefixWidth),
            color: index === 0 ? tuiTheme.user : undefined,
          },
          { text: line, color: tuiTheme.userMessageText },
        ]);
        return truncateToWidth(rendered, width);
      }),
      separator,
    ];

    this.cachedWidth = width;
    this.cachedLines = lines;

    return lines;
  }
}

function formatImage(image: UserImage, index: number): string {
  const format = image.mimeType.slice("image/".length).toUpperCase();
  return `[Image ${index + 1} · ${format} · ${image.width}×${image.height} · ${formatByteSize(
    base64ByteLength(image.data),
  )}]`;
}
