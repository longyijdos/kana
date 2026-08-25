import type { BackgroundJobClient, BackgroundJobSummary } from "@/jobs";
import { BackgroundJobManager, type BackgroundJobManagerAction, type Editor } from "../components";
import type { Tui } from "../runtime";
import type { AppLayout } from "./app-layout";

export type BackgroundJobManagerControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  tui: Tui;
  getJobs: () => BackgroundJobClient | undefined;
  showError: (error: unknown) => void;
  restoreBottom: (focus: boolean) => void;
  onClose: () => void;
};

export class BackgroundJobManagerController {
  private manager?: BackgroundJobManager;
  private jobs?: BackgroundJobClient;
  private unsubscribe?: () => void;
  private killing = false;

  constructor(private readonly options: BackgroundJobManagerControllerOptions) {}

  get active(): boolean {
    return this.manager !== undefined;
  }

  open(): void {
    if (this.manager) {
      return;
    }
    this.options.editor.clear();
    this.jobs = this.options.getJobs();
    this.manager = new BackgroundJobManager((action) => this.handleAction(action));
    this.unsubscribe = this.jobs?.subscribe(() => this.refresh());
    this.refresh();
    this.options.layout.showBottom(this.manager);
    this.options.tui.setFocus(this.manager);
    this.options.tui.requestRender();
  }

  close(): void {
    const manager = this.manager;
    if (!manager) {
      return;
    }
    const wasVisible = this.options.layout.isBottom(manager);
    const restoreFocus = this.options.tui.getFocus() === manager;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.manager = undefined;
    this.jobs = undefined;
    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
    }
    this.options.onClose();
  }

  private handleAction(action: BackgroundJobManagerAction): void {
    switch (action.type) {
      case "close":
        this.close();
        break;
      case "kill":
        void this.kill(action.job);
        break;
      case "refresh":
        this.refresh();
        break;
      case "select":
        this.refreshPreview(action.job.id);
        break;
    }
  }

  private refresh(notice?: string): void {
    const manager = this.manager;
    if (!manager) {
      return;
    }
    try {
      const jobs = this.jobs?.list() ?? [];
      manager.replaceJobs(jobs, notice ?? (this.jobs ? undefined : "No active session."));
      this.refreshPreview(manager.selectedJob?.id);
      for (const job of jobs) {
        if (job.status !== "running" && job.status !== "stopping") {
          this.jobs?.observe(job.id);
        }
      }
    } catch (error) {
      this.options.showError(error);
      manager.replaceJobs([], "Unable to load Background Jobs.");
    }
    this.options.tui.requestRender();
  }

  private refreshPreview(jobId: string | undefined): void {
    const manager = this.manager;
    if (!manager) {
      return;
    }
    try {
      manager.replacePreview(jobId ? this.jobs?.peek(jobId) : undefined);
    } catch (error) {
      this.options.showError(error);
      manager.replacePreview(undefined);
    }
    this.options.tui.requestRender();
  }

  private async kill(job: BackgroundJobSummary): Promise<void> {
    if (this.killing || !this.jobs) {
      return;
    }
    this.killing = true;
    try {
      const settlement = this.jobs.kill(job.id, {
        source: "tui",
        reason: "Stopped from the /jobs manager.",
      });
      this.refresh(`Stopping ${shortJobId(job.id)}...`);
      const result = await settlement;
      this.refresh(`${shortJobId(result.id)} ${result.status}.`);
    } catch (error) {
      this.options.showError(error);
      this.refresh("Unable to stop Background Job.");
    } finally {
      this.killing = false;
    }
  }
}

function shortJobId(jobId: string): string {
  return jobId.startsWith("job_") ? jobId.slice(4, 12) : jobId.slice(0, 8);
}
