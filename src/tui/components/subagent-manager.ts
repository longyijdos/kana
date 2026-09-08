import type { KanaSubagentProfile, KanaSubagentSnapshot, KanaSubagentSummary } from "@/kana";
import { color, dim, stripTerminalControlSequences, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const VISIBLE_LIMIT = 5;
const RESERVED_ROWS = 10;

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
    const lines = [color("Agents · profiles and current session runs", tuiTheme.bottomTitle)];
    lines.push(dim("Profiles"));
    if (this.profiles.length === 0) {
      lines.push(dim("  No valid subagent profiles."));
    } else {
      for (const profile of this.profiles) {
        lines.push(
          truncateToWidth(
            dim(`  ${profile.name} (${profile.source}) · ${singleLine(profile.description)}`),
            width,
            "",
          ),
        );
      }
    }
    lines.push(dim("Runs"));
    if (this.subagents.length === 0) {
      lines.push(dim("  No subagent runs for this session."));
    } else {
      this.viewport.setVisibleLimit(
        visibleLimitForHeight(VISIBLE_LIMIT, availableHeight, RESERVED_ROWS + this.profiles.length),
        this.subagents.length,
      );
      const window = this.viewport.window(this.subagents.length);
      for (let index = window.start; index < window.end; index += 1) {
        const subagent = this.subagents[index] as KanaSubagentSummary;
        const selected = index === this.viewport.selectedIndex;
        const line = `${selected ? "> " : "  "}${shortId(subagent.id)} · ${subagent.profile} · ${subagent.status} · ${singleLine(subagent.label)}`;
        lines.push(
          truncateToWidth(color(line, selected ? tuiTheme.user : tuiTheme.muted), width, ""),
        );
      }
      lines.push(...this.renderPreview(width));
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

  private renderPreview(width: number): string[] {
    const selected = this.selectedSubagent;
    const preview = this.preview;
    if (!selected || !preview || preview.id !== selected.id) return [dim("(loading result)")];
    const text = stripTerminalControlSequences(preview.error ?? preview.output);
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-3);
    if (lines.length === 0) return [dim("(no final output)")];
    return lines.map((line) => truncateToWidth(dim(line), width, ""));
  }
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
