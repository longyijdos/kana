import type { HostedToolContent } from "@/core";
import {
  bold,
  color,
  stripTerminalControlSequences,
  summarizeText,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "../../render";
import type { Component } from "../../runtime";
import { tuiTheme } from "../../theme";
import { type Clock, ElapsedTimer } from "../../utils/elapsed-timer";
import type { ToolActivityGroupState, ToolActivityItem } from "./tool-activity-group";

export class HostedToolBlock implements Component {
  private readonly timer: ElapsedTimer;
  private renderVersion = 0;
  private cachedWidth?: number;
  private cachedVersion?: number;
  private cachedElapsedSeconds?: number;
  private cachedLines?: string[];

  constructor(
    private content: HostedToolContent,
    now: Clock = Date.now,
  ) {
    this.timer = new ElapsedTimer(now);
    if (content.status === "in_progress") {
      this.timer.start();
    }
  }

  update(content: HostedToolContent): void {
    this.content = structuredClone(content);
    if (content.status !== "in_progress") {
      this.timer.stop();
    } else if (!this.timer.active) {
      this.timer.start();
    }
    this.invalidate();
  }

  hasActiveTimer(): boolean {
    return this.timer.active;
  }

  stopTimer(): void {
    this.timer.stop();
    this.invalidate();
  }

  getWebActivity(): ToolActivityItem | undefined {
    // Responses providers commit the concrete Search/Open/Find action only at
    // hosted_tool_end. Hiding provisional actions prevents a generic Search
    // row from changing identity when the completed action arrives.
    if (this.content.name !== "web_search" || this.content.status !== "completed") {
      return undefined;
    }

    return {
      ...formatWebActivity(this.content),
      state: "done",
    };
  }

  getWebActivityState(): ToolActivityGroupState | undefined {
    if (this.content.name !== "web_search") {
      return undefined;
    }

    return this.content.status === "in_progress"
      ? "active"
      : this.content.status === "canceled"
        ? "canceled"
        : "done";
  }

  invalidate(): void {
    this.renderVersion += 1;
    this.cachedWidth = undefined;
    this.cachedVersion = undefined;
    this.cachedElapsedSeconds = undefined;
    this.cachedLines = undefined;
  }

  render(width: number, _availableHeight?: number): string[] {
    const inProgress = this.content.status === "in_progress";
    const elapsedSeconds = inProgress ? this.timer.elapsedSeconds() : undefined;
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedVersion === this.renderVersion &&
      this.cachedElapsedSeconds === elapsedSeconds
    ) {
      return this.cachedLines;
    }

    const title = formatHostedToolTitle(this.content);
    const titleColor =
      this.content.status === "canceled"
        ? tuiTheme.muted
        : inProgress
          ? tuiTheme.toolActive
          : tuiTheme.toolSuccess;
    const activity = `${title.activity}${elapsedSeconds === undefined ? "" : ` (${elapsedSeconds}s)`}`;
    const hint =
      inProgress && this.timer.active ? color(" (Esc to abort)", tuiTheme.shortcutHint) : "";
    const lines = [`${bold(color(`◆ ${activity}`, titleColor))}${hint}`];
    const prefix = "  └ ";
    const continuationPrefix = " ".repeat(visibleWidth(prefix));

    if (title.target) {
      for (const [index, line] of wrapPlainText(
        title.target,
        Math.max(1, width - visibleWidth(prefix)),
      ).entries()) {
        lines.push(`${index === 0 ? prefix : continuationPrefix}${line}`);
      }
    }

    const rendered = lines.map((line) => truncateToWidth(line, width));
    this.cachedWidth = width;
    this.cachedVersion = this.renderVersion;
    this.cachedElapsedSeconds = elapsedSeconds;
    this.cachedLines = rendered;
    return rendered;
  }
}

function formatHostedToolTitle(content: HostedToolContent): {
  activity: string;
  target?: string;
} {
  if (content.name !== "web_search") {
    return {
      activity:
        content.status === "canceled"
          ? "Provider tool stopped"
          : content.status === "in_progress"
            ? "Using provider tool"
            : "Used provider tool",
      target: safeText(content.name),
    };
  }
  if (content.status === "canceled") {
    return { activity: "Web search stopped" };
  }
  if (content.status === "in_progress") {
    return { activity: "Searching the web" };
  }

  switch (content.action?.type) {
    case "search":
      return {
        activity: "Searched the web",
        target: formatSearchQueries(content.action.queries, content.action.query),
      };
    case "open_page":
      return {
        activity: "Opened a web page",
        target: content.action.url ? formatUrl(content.action.url) : undefined,
      };
    case "find_in_page":
      return {
        activity: "Searched within a web page",
        target: formatFindTarget(content.action.pattern, content.action.url),
      };
    default:
      return { activity: "Used web search" };
  }
}

function formatWebActivity(content: HostedToolContent): { label: string; target?: string } {
  switch (content.action?.type) {
    case "search":
      return {
        label: "Search",
        target: formatSearchQueries(content.action.queries, content.action.query),
      };
    case "open_page":
      return {
        label: "Open",
        target: content.action.url ? formatUrl(content.action.url) : undefined,
      };
    case "find_in_page":
      return {
        label: "Find",
        target: formatFindTarget(content.action.pattern, content.action.url),
      };
    default:
      return { label: "Search" };
  }
}

function formatSearchQueries(
  queries: string[] | undefined,
  query: string | undefined,
): string | undefined {
  const values = queries?.length ? queries : query ? [query] : [];
  const normalized = [...new Set(values.map(safeText).filter(Boolean))];
  return normalized.length ? summarizeText(normalized.join(" · "), 240) : undefined;
}

function formatFindTarget(
  pattern: string | undefined,
  url: string | undefined,
): string | undefined {
  const safePattern = pattern ? safeText(pattern) : undefined;
  const safeUrl = url ? formatUrl(url) : undefined;
  if (safePattern && safeUrl) {
    return summarizeText(`“${safePattern}” · ${safeUrl}`, 240);
  }
  return safePattern ?? safeUrl;
}

function formatUrl(value: string): string {
  const safe = safeText(value);
  try {
    const url = new URL(safe);
    return summarizeText(`${url.hostname}${url.pathname === "/" ? "" : url.pathname}`, 180);
  } catch {
    return summarizeText(safe, 180);
  }
}

function safeText(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
