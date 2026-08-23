import { color, dim, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const TOOL_HISTORY_PICKER_VISIBLE_LIMIT = 10;
const TOOL_HISTORY_PICKER_RESERVED_ROWS = 3;

// Picker rows are tool-agnostic: title plus an optional one-line summary.
// Tool-specific composition happens in ToolCallBlock / tools formatting, so
// this component never needs to understand Bash/Edit/Write schemas.
export type ToolHistoryEntry = {
  toolCallId: string;
  title: string;
  summary?: string;
};

export type ToolHistoryPickerDecision =
  | {
      type: "select";
      toolCallId: string;
    }
  | {
      type: "cancel";
    };

// Generic list picker over a snapshot of the session's tool calls. It only
// renders entries, tracks the selection, and reports Enter/Esc; opening the
// inspector is the controller's job.
export class ToolHistoryPicker implements Component {
  private readonly viewport: ListViewport;
  private readonly maximumVisibleEntries: number;

  constructor(
    private readonly entries: ToolHistoryEntry[],
    private readonly finish: (decision: ToolHistoryPickerDecision) => void,
    visibleLimit = TOOL_HISTORY_PICKER_VISIBLE_LIMIT,
  ) {
    this.maximumVisibleEntries = visibleLimit;
    this.viewport = new ListViewport(this.maximumVisibleEntries);
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.finish({ type: "cancel" });
      return;
    }

    if (isEnter(data)) {
      const entry = this.entries[this.viewport.selectedIndex];

      if (entry) {
        this.finish({
          type: "select",
          toolCallId: entry.toolCallId,
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

  render(width: number, availableHeight?: number): string[] {
    const lines = [color("Tool history", tuiTheme.bottomTitle)];

    if (this.entries.length === 0) {
      lines.push(dim("No tool calls in this session."));
      return lines;
    }

    this.viewport.setVisibleLimit(
      visibleLimitForHeight(
        this.maximumVisibleEntries,
        availableHeight,
        TOOL_HISTORY_PICKER_RESERVED_ROWS,
      ),
      this.entries.length,
    );
    const viewport = this.viewport.window(this.entries.length);

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier tools`));
    }

    for (let index = viewport.start; index < viewport.end; index += 1) {
      const entry = this.entries[index];
      const marker = index === this.viewport.selectedIndex ? "> " : "  ";
      const label = `${marker}${formatEntry(entry)}`;
      const rendered =
        index === this.viewport.selectedIndex
          ? color(label, tuiTheme.user)
          : color(label, tuiTheme.muted);

      lines.push(truncateToWidth(rendered, width, ""));
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more tools`));
    }

    return lines;
  }

  private move(delta: number): void {
    this.viewport.move(delta, this.entries.length);
  }
}

function formatEntry(entry: ToolHistoryEntry): string {
  return entry.summary === undefined ? entry.title : `${entry.title}  ${entry.summary}`;
}
