import type { KanaSessionMetadata } from "@/kana";
import { color, dim, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import {
  isDown,
  isEnter,
  isEscape,
  isUp,
} from "../runtime";
import { tuiTheme } from "../theme";

export type SessionPickerDecision =
  | {
      type: "select";
      session: KanaSessionMetadata;
    }
  | {
      type: "cancel";
    };

export class SessionPicker implements Component {
  private selectedIndex = 0;

  constructor(
    private readonly sessions: KanaSessionMetadata[],
    private readonly finish: (decision: SessionPickerDecision) => void,
  ) {}

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.finish({ type: "cancel" });
      return;
    }

    if (isEnter(data)) {
      const session = this.sessions[this.selectedIndex];

      if (session) {
        this.finish({
          type: "select",
          session,
        });
      }
      return;
    }

    if (isUp(data)) {
      this.move(-1);
      return;
    }

    if (isDown(data)) {
      this.move(1);
    }
  }

  render(width: number): string[] {
    const lines = [
      "",
      color("Sessions", tuiTheme.muted),
    ];

    if (this.sessions.length === 0) {
      lines.push(dim("No saved sessions for this workspace."));
      return lines;
    }

    for (const [index, session] of this.sessions.entries()) {
      const marker = index === this.selectedIndex ? "> " : "  ";
      const label = `${marker}${formatSession(session)}`;
      const rendered =
        index === this.selectedIndex
          ? color(label, tuiTheme.user)
          : color(label, tuiTheme.muted);

      lines.push(truncateToWidth(rendered, width, ""));
    }

    return lines;
  }

  private move(delta: number): void {
    if (this.sessions.length === 0) {
      return;
    }

    this.selectedIndex =
      (this.selectedIndex + delta + this.sessions.length) % this.sessions.length;
  }
}

function formatSession(session: KanaSessionMetadata): string {
  const created = formatLocalTimestamp(session.createdAt);
  const title = session.title || "Untitled session";
  const model = session.model
    ? `${session.model.provider}/${session.model.model}`
    : "unknown model";

  return `${created}  ${shortId(session.id)}  ${title}  ${model}`;
}

function formatLocalTimestamp(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp.replace("T", " ").slice(0, 19);
  }

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${[
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":")}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
