import { createUserMessage, type UserImage, type UserMessage } from "@/core";

import { padRightAnsi, renderHighlightedLine, visibleWidth, wrapPlainText } from "../../render";
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

    const frameWidth = Math.max(width, 8);
    const contentWidth = Math.max(1, frameWidth - 4);
    const prefixWidth = visibleWidth(PREFIX);
    const messageLines = this.message.content
      ? wrapPlainText(this.message.content, Math.max(1, contentWidth - prefixWidth))
      : [];
    const rows = [
      ...(this.message.images ?? []).map((image, index) => formatImage(image, index)),
      ...messageLines,
    ];
    if (rows.length === 0) {
      rows.push("");
    }
    const lines = [
      `+${"-".repeat(frameWidth - 2)}+`,
      ...rows.map((line, index) =>
        this.renderRow(
          [
            {
              text: index === 0 ? PREFIX : " ".repeat(prefixWidth),
              color: index === 0 ? tuiTheme.user : undefined,
            },
            { text: line, color: tuiTheme.userMessageText },
          ],
          contentWidth,
        ),
      ),
      `+${"-".repeat(frameWidth - 2)}+`,
    ];

    this.cachedWidth = width;
    this.cachedLines = lines;

    return lines;
  }

  private renderRow(
    tokens: Parameters<typeof renderHighlightedLine>[0],
    contentWidth: number,
  ): string {
    const content = renderHighlightedLine(tokens);

    return `| ${padRightAnsi(content, contentWidth)} |`;
  }
}

function formatImage(image: UserImage, index: number): string {
  const format = image.mimeType.slice("image/".length).toUpperCase();
  return `[Image ${index + 1} · ${format} · ${image.width}×${image.height} · ${formatByteSize(
    base64ByteLength(image.data),
  )}]`;
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatByteSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
