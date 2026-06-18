import type { KanaSessionMetadata } from "@/kana";
import { color, dim, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport } from "../utils/list-viewport";

const SESSION_PICKER_VISIBLE_LIMIT = 10;

export type SessionPickerDecision =
  | {
      type: "select";
      session: KanaSessionMetadata;
    }
  | {
      type: "cancel";
    };

export class SessionPicker implements Component {
  private readonly viewport: ListViewport;

  constructor(
    private readonly sessions: KanaSessionMetadata[],
    private readonly finish: (decision: SessionPickerDecision) => void,
    visibleLimit = SESSION_PICKER_VISIBLE_LIMIT,
  ) {
    this.viewport = new ListViewport(visibleLimit);
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.finish({ type: "cancel" });
      return;
    }

    if (isEnter(data)) {
      const session = this.sessions[this.viewport.selectedIndex];

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
    const lines = ["", color("Sessions", tuiTheme.muted)];

    if (this.sessions.length === 0) {
      lines.push(dim("No saved sessions for this workspace."));
      return lines;
    }

    const viewport = this.viewport.window(this.sessions.length);

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier sessions`));
    }

    for (let index = viewport.start; index < viewport.end; index += 1) {
      const session = this.sessions[index];
      const marker = index === this.viewport.selectedIndex ? "> " : "  ";
      const label = `${marker}${formatSession(session)}`;
      const rendered =
        index === this.viewport.selectedIndex
          ? color(label, tuiTheme.user)
          : color(label, tuiTheme.muted);

      lines.push(truncateToWidth(rendered, width, ""));
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more sessions`));
    }

    return lines;
  }

  private move(delta: number): void {
    this.viewport.move(delta, this.sessions.length);
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

  return `${[date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-")} ${[
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
