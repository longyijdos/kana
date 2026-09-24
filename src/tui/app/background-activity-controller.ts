import type { BackgroundJobClient, BackgroundJobSummary } from "@/jobs";
import type { KanaSubagentClient, KanaSubagentSummary, KanaUserTaskManager } from "@/kana";
import type { Editor, EditorBackgroundActivityItem, EditorUserTaskItem } from "../components";
import type { Tui } from "../runtime";

export type BackgroundActivityControllerOptions = {
  editor: Editor;
  tui: Tui;
  getJobs: () => BackgroundJobClient | undefined;
  getSubagents: () => KanaSubagentClient | undefined;
  getUserTasks: () => KanaUserTaskManager | undefined;
};

/** Read-only projection of the current session's active work into the editor.
 * It never acknowledges, cancels, or otherwise changes the work it displays.
 */
export class BackgroundActivityController {
  private jobs?: BackgroundJobClient;
  private subagents?: KanaSubagentClient;
  private userTasks?: KanaUserTaskManager;
  private unsubscribeJobs?: () => void;
  private unsubscribeSubagents?: () => void;
  private unsubscribeUserTasks?: () => void;

  constructor(private readonly options: BackgroundActivityControllerOptions) {}

  bind(): void {
    this.unbind();
    this.jobs = this.options.getJobs();
    this.subagents = this.options.getSubagents();
    this.userTasks = this.options.getUserTasks();
    this.unsubscribeJobs = this.jobs?.subscribe(() => this.refresh());
    this.unsubscribeSubagents = this.subagents?.subscribe(() => this.refresh());
    this.unsubscribeUserTasks = this.userTasks?.subscribeChanges(() => this.refresh());
    this.refresh();
  }

  unbind(): void {
    this.unsubscribeJobs?.();
    this.unsubscribeSubagents?.();
    this.unsubscribeUserTasks?.();
    this.unsubscribeJobs = undefined;
    this.unsubscribeSubagents = undefined;
    this.unsubscribeUserTasks = undefined;
    this.jobs = undefined;
    this.subagents = undefined;
    this.userTasks = undefined;
    // Without clients the projection can no longer be kept accurate, so the
    // strip is released together with its binding.
    this.options.editor.setBackgroundActivity([]);
    this.options.editor.setPendingUserTasks([]);
    this.options.tui.requestRender();
  }

  refresh(): void {
    this.options.editor.setBackgroundActivity(this.collectActiveItems());
    this.options.editor.setPendingUserTasks(this.collectPendingUserTasks());
    this.options.tui.requestRender();
  }

  private collectPendingUserTasks(): EditorUserTaskItem[] {
    return (this.userTasks?.list() ?? [])
      .filter((task) => task.status === "pending")
      .map((task) => ({
        id: task.id.startsWith("task_") ? task.id.slice(5, 13) : task.id.slice(0, 8),
        label: task.task,
      }));
  }

  private collectActiveItems(): EditorBackgroundActivityItem[] {
    const subagents = (this.subagents?.list() ?? [])
      .filter((subagent) => subagent.status === "running")
      .map(toSubagentItem);
    const jobs = (this.jobs?.list() ?? []).filter(isActiveJob).map(toJobItem);
    return [...subagents, ...jobs];
  }
}

function toSubagentItem(subagent: KanaSubagentSummary): EditorBackgroundActivityItem {
  return {
    kind: "subagent",
    id: shortSubagentId(subagent.id),
    status: subagent.status,
    label: subagent.label,
  };
}

function toJobItem(job: BackgroundJobSummary): EditorBackgroundActivityItem {
  return {
    kind: "job",
    id: shortJobId(job.id),
    status: job.status,
    label: job.label,
  };
}

function isActiveJob(job: BackgroundJobSummary): boolean {
  return job.status === "running" || job.status === "stopping";
}

function shortSubagentId(id: string): string {
  return id.startsWith("agent_") ? id.slice(6, 14) : id.slice(0, 8);
}

function shortJobId(id: string): string {
  return id.startsWith("job_") ? id.slice(4, 12) : id.slice(0, 8);
}
