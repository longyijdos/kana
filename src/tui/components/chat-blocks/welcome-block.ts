import os from "node:os";
import type { KanaSessionMetadata } from "@/kana";
import { KANA_VERSION } from "@/version";
import { color, padRightAnsi, truncateToWidth, visibleWidth } from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";

type WelcomeBlockOptions = {
  logoLines: readonly string[];
  recentSessions?: readonly KanaSessionMetadata[];
  savedSessionsAvailable?: boolean;
  username?: string;
};

const PANEL_MIN_WIDTH = 73;
const PANEL_MAX_WIDTH = 73;
const LEFT_WIDTH = 34;
const COLUMN_GAP = 1;

export class WelcomeBlock implements Component {
  constructor(private readonly options: WelcomeBlockOptions) {}

  render(width: number, _availableHeight?: number): string[] {
    if (width < PANEL_MIN_WIDTH) {
      return this.renderCompact(width);
    }

    return this.renderPanel(width);
  }

  private renderPanel(width: number): string[] {
    const panelWidth = Math.min(width, PANEL_MAX_WIDTH);
    const innerWidth = panelWidth - 2;
    const rightWidth = innerWidth - LEFT_WIDTH - COLUMN_GAP - 2;
    const leftLines = this.leftColumn(LEFT_WIDTH);
    const rightLines = this.rightColumn(rightWidth);
    const contentHeight = Math.max(leftLines.length, rightLines.length);
    const lines = [this.topBorder(panelWidth)];

    for (let index = 0; index < contentHeight; index += 1) {
      const left = padRightAnsi(leftLines[index] ?? "", LEFT_WIDTH);
      const right = padRightAnsi(rightLines[index] ?? "", rightWidth);

      lines.push(
        [border("|"), left, " ".repeat(COLUMN_GAP), border("|"), " ", right, border("|")].join(""),
      );
    }

    lines.push(this.bottomBorder(panelWidth));

    return lines;
  }

  private renderCompact(width: number): string[] {
    return [
      title("Kana"),
      ...this.options.logoLines.filter((line) => visibleWidth(line) <= width),
      truncateToWidth(text("Plan, act, and follow through from here."), width, ""),
    ];
  }

  private leftColumn(width: number): string[] {
    const logoWidth = Math.max(...this.options.logoLines.map(visibleWidth), 0);
    const logoIndent = " ".repeat(Math.max(0, Math.floor((width - logoWidth) / 2)));
    const greeting = `Welcome back, ${this.options.username ?? os.userInfo().username}`;

    return [
      "",
      truncateToWidth(text(greeting), width, ""),
      "",
      ...this.options.logoLines.map((line) => `${logoIndent}${line}`),
      "",
    ];
  }

  private rightColumn(width: number): string[] {
    const recentSessions = (this.options.recentSessions ?? []).slice(0, 3);
    const savedSessionsAvailable = this.options.savedSessionsAvailable !== false;
    const rows = [
      title("Recent activity"),
      ...(recentSessions.length > 0
        ? recentSessions.map((session) => text(`  ${formatSessionTitle(session)}`))
        : savedSessionsAvailable
          ? [
              text("  No recent sessions yet"),
              text("  Start a conversation"),
              text("  Your work will appear here"),
            ]
          : [
              text("  Temporary clean session"),
              text("  Nothing will be saved"),
              text("  Discarded on exit"),
            ]),
      ...(savedSessionsAvailable ? [muted("  ... /resume for more")] : []),
      "",
      title("Highlights"),
      text("  Session-owned background jobs"),
      text("  Durable session todos"),
      text("  Bounded agent goal execution"),
      muted("  ... /help for more"),
    ];

    return rows.map((row) => truncateToWidth(row, width));
  }

  private topBorder(width: number): string {
    const label = ` ${title("Kana")} ${muted(`v${KANA_VERSION}`)} `;
    const labelWidth = visibleWidth(label);
    const left = "-".repeat(2);
    const right = "-".repeat(Math.max(0, width - left.length - labelWidth - 2));

    return `${border(`+${left}`)}${label}${border(`${right}+`)}`;
  }

  private bottomBorder(width: number): string {
    return border(`+${"-".repeat(width - 2)}+`);
  }
}

function border(value: string): string {
  return color(value, tuiTheme.welcomeBorder);
}

function title(value: string): string {
  return color(value, tuiTheme.welcomeTitle);
}

function muted(value: string): string {
  return color(value, tuiTheme.welcomeMuted);
}

function text(value: string): string {
  return color(value, tuiTheme.welcomeText);
}

function formatSessionTitle(session: KanaSessionMetadata): string {
  return session.title || shortId(session.id);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
