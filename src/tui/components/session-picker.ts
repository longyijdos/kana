import type { KanaSessionMetadata } from "@/kana";
import { shortId } from "@/utils";
import { color, dim, pad2, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isEnter, isEscape } from "../runtime";
import { tuiTheme } from "../theme";
import type { Clock } from "../utils/elapsed-timer";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const SESSION_PICKER_VISIBLE_LIMIT = 10;
const SESSION_PICKER_RESERVED_ROWS = 4;
const SESSION_PICKER_HELP = "Enter resume · ↑/↓ select · ←/→ page · K delete · Esc close";
const ACTIVITY_COLUMN_WIDTH = 13;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export type SessionPickerDecision =
  | {
      type: "select";
      session: KanaSessionMetadata;
    }
  | {
      type: "delete";
      session: KanaSessionMetadata;
    }
  | {
      type: "cancel";
    };

export class SessionPicker implements Component {
  private readonly viewport: ListViewport;
  private readonly maximumVisibleSessions: number;

  constructor(
    private sessions: KanaSessionMetadata[],
    private readonly finish: (decision: SessionPickerDecision) => void,
    visibleLimit = SESSION_PICKER_VISIBLE_LIMIT,
    private readonly now: Clock = Date.now,
  ) {
    this.maximumVisibleSessions = visibleLimit;
    this.viewport = new ListViewport(this.maximumVisibleSessions);
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.finish({ type: "cancel" });
      return;
    }

    if (data === "k" || data === "K") {
      const session = this.sessions[this.viewport.selectedIndex];

      if (session) {
        this.finish({ type: "delete", session });
      }
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

    if (this.viewport.handleNavigationKey(data, this.sessions.length)) {
      return;
    }
  }

  replaceSessions(sessions: KanaSessionMetadata[]): void {
    this.sessions = sessions;
    this.viewport.moveTo(this.viewport.selectedIndex, sessions.length);
  }

  render(width: number, availableHeight?: number): string[] {
    const lines = [color("Sessions", tuiTheme.bottomTitle)];

    if (this.sessions.length === 0) {
      lines.push(dim("No saved sessions for this workspace."));
      lines.push(dim(SESSION_PICKER_HELP));
      return lines;
    }

    this.viewport.setVisibleLimit(
      visibleLimitForHeight(
        this.maximumVisibleSessions,
        availableHeight,
        SESSION_PICKER_RESERVED_ROWS,
      ),
      this.sessions.length,
    );
    const viewport = this.viewport.visible(this.sessions);
    const now = this.now();

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier sessions`));
    }

    for (const { item: session, selected } of viewport.rows) {
      const marker = selected ? "> " : "  ";
      const label = `${marker}${formatSession(session, now)}`;
      const rendered = selected ? color(label, tuiTheme.user) : color(label, tuiTheme.muted);

      lines.push(truncateToWidth(rendered, width));
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more sessions`));
    }

    lines.push(dim(SESSION_PICKER_HELP));
    return lines;
  }
}

function formatSession(session: KanaSessionMetadata, now: number): string {
  const activity = formatActivityTime(session.updatedAt, now);
  const title = session.title || "Untitled session";

  return `${activity.padEnd(ACTIVITY_COLUMN_WIDTH)}${shortId(session.id)}  ${title}`;
}

function formatActivityTime(timestamp: string, now: number): string {
  const activity = Date.parse(timestamp);

  if (Number.isNaN(activity)) {
    return timestamp;
  }

  const elapsed = now - activity;

  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  }
  if (elapsed < WEEK_MS) {
    return `${Math.floor(elapsed / DAY_MS)}d ago`;
  }

  const date = new Date(activity);

  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${MONTH_NAMES[date.getMonth()]} ${pad2(date.getDate())}`;
  }

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
