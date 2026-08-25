import type { BackgroundJobPeekSnapshot, BackgroundJobSummary } from "@/jobs";
import { color, dim, stripTerminalControlSequences, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const JOB_VISIBLE_LIMIT = 5;
const JOB_RESERVED_ROWS = 7;

export type BackgroundJobManagerAction =
  | { type: "close" }
  | { type: "kill"; job: BackgroundJobSummary }
  | { type: "refresh" }
  | { type: "select"; job: BackgroundJobSummary };

export class BackgroundJobManager implements Component {
  private readonly viewport = new ListViewport(JOB_VISIBLE_LIMIT);
  private jobs: BackgroundJobSummary[] = [];
  private preview?: BackgroundJobPeekSnapshot;
  private notice?: string;

  constructor(private readonly onAction: (action: BackgroundJobManagerAction) => void) {}

  get selectedJob(): BackgroundJobSummary | undefined {
    const job = this.jobs[this.viewport.selectedIndex];
    return job ? cloneJob(job) : undefined;
  }

  replaceJobs(jobs: BackgroundJobSummary[], notice?: string): void {
    const selectedId = this.selectedJob?.id;
    const previousIndex = this.viewport.selectedIndex;
    this.jobs = jobs.map(cloneJob);
    this.notice = notice;

    const selectedIndex = selectedId
      ? this.jobs.findIndex((candidate) => candidate.id === selectedId)
      : -1;
    this.viewport.moveTo(
      selectedIndex >= 0 ? selectedIndex : Math.min(previousIndex, this.jobs.length - 1),
      this.jobs.length,
    );
    if (this.preview?.jobId !== this.selectedJob?.id) {
      this.preview = undefined;
    }
  }

  replacePreview(preview: BackgroundJobPeekSnapshot | undefined): void {
    this.preview = preview;
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
      const job = this.selectedJob;
      if (job && isActive(job)) {
        this.onAction({ type: "kill", job });
      }
      return;
    }
    if (isUp(data)) {
      this.moveSelection(-1);
      return;
    }
    if (isDown(data)) {
      this.moveSelection(1);
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const lines = [color("Background Jobs · current session", tuiTheme.bottomTitle)];
    if (this.jobs.length === 0) {
      lines.push(dim(this.notice ?? "No Background Jobs for this session."));
      lines.push(dim("R refresh · Esc close"));
      return lines;
    }

    this.viewport.setVisibleLimit(
      visibleLimitForHeight(JOB_VISIBLE_LIMIT, availableHeight, JOB_RESERVED_ROWS),
      this.jobs.length,
    );
    const viewport = this.viewport.window(this.jobs.length);
    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier Jobs`));
    }
    for (let index = viewport.start; index < viewport.end; index += 1) {
      const job = this.jobs[index];
      const selected = index === this.viewport.selectedIndex;
      const marker = selected ? "> " : "  ";
      const label = `${marker}${shortJobId(job.id)} · ${job.status} · ${singleLine(job.label)}`;
      lines.push(
        truncateToWidth(color(label, selected ? tuiTheme.user : tuiTheme.muted), width, ""),
      );
    }
    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more Jobs`));
    }

    const selected = this.selectedJob;
    if (selected) {
      lines.push(dim(`${shortJobId(selected.id)} output tail (non-consuming)`));
      lines.push(...this.renderPreview(width, availableHeight, lines.length));
    }
    if (this.notice) {
      lines.push(truncateToWidth(dim(this.notice), width, "..."));
    }
    lines.push(dim("K stop · R refresh · ↑/↓ select · Esc close"));
    return lines;
  }

  private moveSelection(delta: number): void {
    const previous = this.viewport.selectedIndex;
    this.viewport.move(delta, this.jobs.length);
    if (this.viewport.selectedIndex !== previous) {
      const job = this.selectedJob;
      if (job) {
        this.onAction({ type: "select", job });
      }
    }
  }

  private renderPreview(
    width: number,
    availableHeight: number | undefined,
    usedRows: number,
  ): string[] {
    const preview = this.preview;
    if (!preview || preview.jobId !== this.selectedJob?.id) {
      return [dim("(loading output)")];
    }
    const text = stripTerminalControlSequences(preview.chunks.map((chunk) => chunk.text).join(""));
    const outputLines = text.split(/\r?\n/);
    if (outputLines.at(-1) === "") {
      outputLines.pop();
    }
    const maximum =
      availableHeight === undefined
        ? 4
        : Math.max(1, Math.min(4, Math.floor(availableHeight) - usedRows - 1));
    const visible = outputLines
      .slice(-maximum)
      .map((line) => truncateToWidth(dim(line), width, ""));
    const truncated = preview.truncated || outputLines.length > visible.length;
    if (visible.length === 0) {
      return [dim("(no output)")];
    }
    if (!truncated) {
      return visible;
    }
    return maximum === 1 ? [dim("…")] : [dim("…"), ...visible.slice(-(maximum - 1))];
  }
}

function cloneJob(job: BackgroundJobSummary): BackgroundJobSummary {
  return {
    ...job,
    startedAt: new Date(job.startedAt.getTime()),
    ...(job.finishedAt === undefined ? {} : { finishedAt: new Date(job.finishedAt.getTime()) }),
  };
}

function isActive(job: BackgroundJobSummary): boolean {
  return job.status === "running" || job.status === "stopping";
}

function shortJobId(jobId: string): string {
  return jobId.startsWith("job_") ? jobId.slice(4, 12) : jobId.slice(0, 8);
}

function singleLine(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
