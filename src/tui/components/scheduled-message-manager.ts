import type { WakeEventOrigin } from "@/kana";
import { color, dim, stripTerminalControlSequences, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const SCHEDULED_MESSAGE_VISIBLE_LIMIT = 10;
const SCHEDULED_MESSAGE_RESERVED_ROWS = 4;

export type ScheduledMessageManagerItem = {
  id: string;
  state: "future" | "pending";
  dueAt: Date;
  origin: WakeEventOrigin;
  message: string;
};

export type ScheduledMessageManagerAction =
  | { type: "add" }
  | { type: "delete"; item: ScheduledMessageManagerItem }
  | { type: "refresh" }
  | { type: "close" };

export class ScheduledMessageManager implements Component {
  private readonly viewport: ListViewport;
  private readonly maximumVisibleMessages: number;
  private items: ScheduledMessageManagerItem[] = [];
  private snapshotAt = new Date();
  private notice?: string;

  constructor(
    private readonly onAction: (action: ScheduledMessageManagerAction) => void,
    visibleLimit = SCHEDULED_MESSAGE_VISIBLE_LIMIT,
  ) {
    this.maximumVisibleMessages = visibleLimit;
    this.viewport = new ListViewport(this.maximumVisibleMessages);
  }

  replaceItems(items: ScheduledMessageManagerItem[], notice?: string): void {
    const selectedId = this.items[this.viewport.selectedIndex]?.id;
    const previousIndex = this.viewport.selectedIndex;

    this.items = items.map((item) => ({ ...item, dueAt: new Date(item.dueAt.getTime()) }));
    this.snapshotAt = new Date();
    this.notice = notice;

    const selectedIndex = selectedId ? this.items.findIndex((item) => item.id === selectedId) : -1;
    this.viewport.moveTo(
      selectedIndex >= 0 ? selectedIndex : Math.min(previousIndex, this.items.length - 1),
      this.items.length,
    );
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.onAction({ type: "close" });
      return;
    }

    if (data === "a" || data === "A") {
      this.onAction({ type: "add" });
      return;
    }

    if (data === "r" || data === "R") {
      this.onAction({ type: "refresh" });
      return;
    }

    if (data === "d" || data === "D") {
      const item = this.items[this.viewport.selectedIndex];
      if (item) {
        this.onAction({
          type: "delete",
          item: { ...item, dueAt: new Date(item.dueAt.getTime()) },
        });
      }
      return;
    }

    if (isUp(data)) {
      this.viewport.move(-1, this.items.length);
      return;
    }

    if (isDown(data)) {
      this.viewport.move(1, this.items.length);
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const lines = [color("Scheduled messages · process only", tuiTheme.bottomTitle)];

    if (this.items.length === 0) {
      lines.push(dim(this.notice ?? "No scheduled messages for this session."));
      lines.push(dim("A add · R refresh · Esc close"));
      return lines;
    }

    this.viewport.setVisibleLimit(
      visibleLimitForHeight(
        this.maximumVisibleMessages,
        availableHeight,
        SCHEDULED_MESSAGE_RESERVED_ROWS,
      ),
      this.items.length,
    );
    const viewport = this.viewport.window(this.items.length);

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier messages`));
    }

    for (let index = viewport.start; index < viewport.end; index += 1) {
      const item = this.items[index];
      const selected = index === this.viewport.selectedIndex;
      const marker = selected ? "> " : "  ";
      const state = item.state === "pending" ? "due" : formatDueAt(item.dueAt, this.snapshotAt);
      const origin = item.origin === "agent" ? "agent" : "you";
      const label = `${marker}${state} · ${origin} · ${formatSingleLine(item.message)}`;

      lines.push(
        truncateToWidth(color(label, selected ? tuiTheme.user : tuiTheme.muted), width, ""),
      );
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more messages`));
    }
    if (this.notice) {
      lines.push(truncateToWidth(dim(this.notice), width, "..."));
    }
    lines.push(dim("A add · D delete · R refresh · Esc close"));
    return lines;
  }
}

function formatDueAt(dueAt: Date, snapshotAt: Date): string {
  const time = [dueAt.getHours(), dueAt.getMinutes(), dueAt.getSeconds()].map(pad).join(":");
  if (sameLocalDate(dueAt, snapshotAt)) {
    return `today ${time}`;
  }

  const tomorrow = new Date(snapshotAt);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameLocalDate(dueAt, tomorrow)) {
    return `tomorrow ${time}`;
  }

  return `${dueAt.getFullYear()}-${pad(dueAt.getMonth() + 1)}-${pad(dueAt.getDate())} ${time}`;
}

function sameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatSingleLine(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
