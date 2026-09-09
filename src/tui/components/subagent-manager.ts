import type { KanaSubagentProfile, KanaSubagentSnapshot, KanaSubagentSummary } from "@/kana";
import {
  color,
  dim,
  stripTerminalControlSequences,
  truncateToWidth,
  visibleWidth,
} from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const VISIBLE_LIMIT = 5;
const FIXED_ROWS = 4;

export type SubagentManagerAction =
  | { type: "close" }
  | { type: "cancel"; subagent: KanaSubagentSummary }
  | { type: "refresh" }
  | { type: "select"; subagent: KanaSubagentSummary }
  | { type: "inspect"; subagent: KanaSubagentSummary };

export class SubagentManager implements Component {
  private readonly viewport = new ListViewport(VISIBLE_LIMIT);
  private profiles: KanaSubagentProfile[] = [];
  private subagents: KanaSubagentSummary[] = [];
  private preview?: KanaSubagentSnapshot;
  private notice?: string;

  constructor(private readonly onAction: (action: SubagentManagerAction) => void) {}

  get selectedSubagent(): KanaSubagentSummary | undefined {
    const value = this.subagents[this.viewport.selectedIndex];
    return value ? cloneSummary(value) : undefined;
  }

  replace(
    profiles: readonly KanaSubagentProfile[],
    subagents: readonly KanaSubagentSummary[],
    notice?: string,
  ): void {
    const selectedId = this.selectedSubagent?.id;
    const previousIndex = this.viewport.selectedIndex;
    this.profiles = profiles.map((profile) => structuredClone(profile));
    this.subagents = subagents.map(cloneSummary);
    this.notice = notice;
    const selectedIndex = selectedId
      ? this.subagents.findIndex((candidate) => candidate.id === selectedId)
      : -1;
    this.viewport.moveTo(
      selectedIndex >= 0 ? selectedIndex : Math.min(previousIndex, this.subagents.length - 1),
      this.subagents.length,
    );
    if (this.preview?.id !== this.selectedSubagent?.id) this.preview = undefined;
  }

  replacePreview(preview: KanaSubagentSnapshot | undefined): void {
    this.preview = preview === undefined ? undefined : cloneSnapshot(preview);
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.onAction({ type: "close" });
      return;
    }
    if (data === "r" || data === "R") {
      this.onAction({ type: "refresh" });
      return;
    }
    if (data === "k" || data === "K") {
      const subagent = this.selectedSubagent;
      if (subagent?.status === "running") this.onAction({ type: "cancel", subagent });
      return;
    }
    if (isEnter(data)) {
      const subagent = this.selectedSubagent;
      if (subagent) this.onAction({ type: "inspect", subagent });
      return;
    }
    if (isUp(data)) {
      this.move(-1);
      return;
    }
    if (isDown(data)) this.move(1);
  }

  render(width: number, availableHeight?: number): string[] {
    const lines = [color("Agents · current session", tuiTheme.bottomTitle)];
    lines.push(dim(renderProfileSummary(this.profiles, width)));
    lines.push(dim("Runs"));
    if (this.subagents.length === 0) {
      lines.push(dim("  No subagent runs for this session."));
    } else {
      const window = this.configureViewport(availableHeight);
      if (window.hiddenBefore > 0) {
        lines.push(dim(`... ${window.hiddenBefore} earlier runs`));
      }
      for (let index = window.start; index < window.end; index += 1) {
        const subagent = this.subagents[index] as KanaSubagentSummary;
        const selected = index === this.viewport.selectedIndex;
        const line = `${selected ? "> " : "  "}${shortId(subagent.id)} · ${subagent.profile} · ${subagent.status} · ${singleLine(subagent.label)}`;
        lines.push(
          truncateToWidth(color(line, selected ? tuiTheme.user : tuiTheme.muted), width, ""),
        );
      }
      if (window.hiddenAfter > 0) {
        lines.push(dim(`... ${window.hiddenAfter} more runs`));
      }
      lines.push(...this.renderPreview(width, availableHeight, lines.length));
    }
    if (this.notice) lines.push(truncateToWidth(dim(this.notice), width, "..."));
    lines.push(dim("Enter transcript · K cancel · R refresh · ↑/↓ select · Esc close"));
    return lines;
  }

  private move(delta: number): void {
    const previous = this.viewport.selectedIndex;
    this.viewport.move(delta, this.subagents.length);
    if (previous !== this.viewport.selectedIndex) {
      const subagent = this.selectedSubagent;
      if (subagent) this.onAction({ type: "select", subagent });
    }
  }

  private configureViewport(availableHeight: number | undefined) {
    const reservedRows = FIXED_ROWS + (this.notice ? 1 : 0);
    let visibleLimit = visibleLimitForHeight(VISIBLE_LIMIT, availableHeight, reservedRows);
    this.viewport.setVisibleLimit(visibleLimit, this.subagents.length);

    if (availableHeight === undefined || !Number.isFinite(availableHeight)) {
      return this.viewport.window(this.subagents.length);
    }

    const availableRows = Math.max(1, Math.floor(availableHeight) - reservedRows);
    while (visibleLimit > 1) {
      const window = this.viewport.window(this.subagents.length);
      const indicatorRows = Number(window.hiddenBefore > 0) + Number(window.hiddenAfter > 0);
      if (window.end - window.start + indicatorRows <= availableRows) return window;
      visibleLimit -= 1;
      this.viewport.setVisibleLimit(visibleLimit, this.subagents.length);
    }
    return this.viewport.window(this.subagents.length);
  }

  private renderPreview(
    width: number,
    availableHeight: number | undefined,
    usedRows: number,
  ): string[] {
    const maximum =
      availableHeight === undefined
        ? 3
        : Math.max(
            0,
            Math.min(3, Math.floor(availableHeight) - usedRows - 1 - (this.notice ? 1 : 0)),
          );
    if (maximum === 0) return [];

    const selected = this.selectedSubagent;
    const preview = this.preview;
    if (!selected || !preview || preview.id !== selected.id) return [dim("(loading result)")];
    const text = stripTerminalControlSequences(preview.error ?? preview.output);
    const outputLines = text.split(/\r?\n/).filter(Boolean);
    const visible = outputLines
      .slice(-maximum)
      .map((line) => truncateToWidth(dim(line), width, ""));
    if (visible.length === 0) return [dim("(no final output)")];
    if (outputLines.length === visible.length) return visible;
    return maximum === 1 ? [dim("…")] : [dim("…"), ...visible.slice(-(maximum - 1))];
  }
}

function renderProfileSummary(profiles: readonly KanaSubagentProfile[], width: number): string {
  const names = profiles.map((profile) => singleLine(profile.name));
  if (names.length === 0) return truncateToWidth("Profiles · none", width, "");

  const complete = `Profiles · ${names.join(" · ")}`;
  if (visibleWidth(complete) <= width) return complete;

  for (let visibleCount = names.length - 1; visibleCount > 0; visibleCount -= 1) {
    const candidate = `Profiles · ${names.slice(0, visibleCount).join(" · ")} · +${names.length - visibleCount} more`;
    if (visibleWidth(candidate) <= width) return candidate;
  }

  const hidden = `+${names.length} more`;
  const separator = " · ";
  const prefixWidth = width - visibleWidth(separator) - visibleWidth(hidden);
  if (prefixWidth <= 0) return truncateToWidth(hidden, width, "");
  return `${truncateToWidth("Profiles", prefixWidth, "…")}${separator}${hidden}`;
}

function cloneSummary(summary: KanaSubagentSummary): KanaSubagentSummary {
  return {
    ...summary,
    startedAt: new Date(summary.startedAt),
    ...(summary.finishedAt === undefined ? {} : { finishedAt: new Date(summary.finishedAt) }),
    ...(summary.model === undefined ? {} : { model: { ...summary.model } }),
  };
}

function cloneSnapshot(snapshot: KanaSubagentSnapshot): KanaSubagentSnapshot {
  return {
    ...cloneSummary(snapshot),
    output: snapshot.output,
    error: snapshot.error,
    waitTimedOut: snapshot.waitTimedOut,
  };
}

function shortId(id: string): string {
  return id.startsWith("agent_") ? id.slice(6, 14) : id.slice(0, 8);
}

function singleLine(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
