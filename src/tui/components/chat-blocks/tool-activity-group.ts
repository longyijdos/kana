import {
  bold,
  color,
  stripTerminalControlSequences,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "../../render";
import { tuiTheme } from "../../theme";

export type ToolActivityState = "preparing" | "running" | "done" | "canceled";

export type ToolActivityItem = {
  label: string;
  target?: string;
  state: ToolActivityState;
  elapsedSeconds?: number;
};

export type ToolActivityGroupTitles = {
  active: string;
  done: string;
  canceled: string;
};

export function renderToolActivityGroup(
  items: ToolActivityItem[],
  titles: ToolActivityGroupTitles,
  width: number,
): string[] {
  if (items.length === 0) {
    return [];
  }

  const active = items.some((item) => item.state === "preparing" || item.state === "running");
  const canceled = !active && items.some((item) => item.state === "canceled");
  const elapsedSeconds = active
    ? Math.max(0, ...items.map((item) => item.elapsedSeconds ?? 0))
    : undefined;
  const title = active ? titles.active : canceled ? titles.canceled : titles.done;
  const titleColor = active
    ? tuiTheme.toolActive
    : canceled
      ? tuiTheme.muted
      : tuiTheme.toolSuccess;
  const elapsed = elapsedSeconds === undefined ? "" : ` (${elapsedSeconds}s)`;
  const hint = active ? color(" (Esc to abort)", tuiTheme.shortcutHint) : "";
  const lines = [`${bold(color(`◆ ${title}${elapsed}`, titleColor))}${hint}`];
  const displayItems = coalesceReads(items);

  for (const [index, item] of displayItems.entries()) {
    const last = index === displayItems.length - 1;
    const prefix = last ? "  └ " : "  ├ ";
    const continuationPrefix = last ? "    " : "  │ ";
    const target = item.target ? ` ${sanitizeActivityText(item.target)}` : "";
    const text = `${sanitizeActivityText(item.label)}${target}`;
    const wrapped = wrapPlainText(text, Math.max(1, width - visibleWidth(prefix)));

    for (const [lineIndex, line] of wrapped.entries()) {
      lines.push(
        color(`${lineIndex === 0 ? prefix : continuationPrefix}${line}`, tuiTheme.toolOutput),
      );
    }
  }

  return lines.map((line) => truncateToWidth(line, width));
}

function coalesceReads(items: ToolActivityItem[]): ToolActivityItem[] {
  const result: ToolActivityItem[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.label !== "Read") {
      if (item) {
        result.push(item);
      }
      continue;
    }

    const targets: string[] = [];
    let nextIndex = index;
    while (nextIndex < items.length && items[nextIndex]?.label === "Read") {
      const target = items[nextIndex]?.target;
      if (target && !targets.includes(target)) {
        targets.push(target);
      }
      nextIndex += 1;
    }

    result.push({
      ...item,
      target: targets.length > 0 ? targets.join(", ") : undefined,
    });
    index = nextIndex - 1;
  }

  return result;
}

function sanitizeActivityText(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
