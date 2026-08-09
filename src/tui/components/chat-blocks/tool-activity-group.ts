import {
  bold,
  color,
  stripTerminalControlSequences,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "../../render";
import { tuiTheme } from "../../theme";

export type ToolActivityState = "running" | "done" | "canceled";

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
  failed: string;
};

export type ToolActivityGroupState = "active" | "done" | "canceled" | "failed";

type ToolActivityGroupOptions = {
  state?: ToolActivityGroupState;
  elapsedSeconds?: number;
  abortable?: boolean;
};

export function renderToolActivityGroup(
  items: ToolActivityItem[],
  titles: ToolActivityGroupTitles,
  width: number,
  options: ToolActivityGroupOptions = {},
): string[] {
  if (
    items.length === 0 &&
    options.state !== "active" &&
    options.state !== "canceled" &&
    options.state !== "failed"
  ) {
    return [];
  }

  const derivedState: ToolActivityGroupState = items.some((item) => item.state === "running")
    ? "active"
    : items.some((item) => item.state === "canceled")
      ? "canceled"
      : "done";
  const state = options.state ?? derivedState;
  const active = state === "active";
  const canceled = state === "canceled";
  const failed = state === "failed";
  const elapsedSeconds = active
    ? (options.elapsedSeconds ?? Math.max(0, ...items.map((item) => item.elapsedSeconds ?? 0)))
    : undefined;
  const title = active
    ? titles.active
    : canceled
      ? titles.canceled
      : failed
        ? titles.failed
        : titles.done;
  const titleColor = active
    ? tuiTheme.toolActive
    : canceled
      ? tuiTheme.muted
      : failed
        ? tuiTheme.error
        : tuiTheme.toolSuccess;
  const elapsed = elapsedSeconds === undefined ? "" : ` (${elapsedSeconds}s)`;
  const hint =
    active && options.abortable !== false ? color(" (Esc to abort)", tuiTheme.shortcutHint) : "";
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
      // Keep full paths through collection so same-named files remain distinct,
      // then shorten only as far as the group can do without losing identity.
      target: targets.length > 0 ? shortestUniquePathSuffixes(targets).join(", ") : undefined,
    });
    index = nextIndex - 1;
  }

  return result;
}

function shortestUniquePathSuffixes(paths: string[]): string[] {
  const segments = paths.map((path) => path.split(/[\\/]/).filter(Boolean));

  return paths.map((path, index) => {
    const pathSegments = segments[index] ?? [];
    for (let depth = 1; depth <= pathSegments.length; depth += 1) {
      const candidate = pathSegments.slice(-depth).join("/");
      const unique = segments.every(
        (otherSegments, otherIndex) =>
          otherIndex === index || otherSegments.slice(-depth).join("/") !== candidate,
      );
      if (unique) {
        return candidate;
      }
    }

    return path.replaceAll("\\", "/");
  });
}

function sanitizeActivityText(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
