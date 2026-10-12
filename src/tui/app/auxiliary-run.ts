import type { StatusLineState } from "../components";
import type { Tui } from "../runtime";
import type { RunPhase } from "./status-phase";

export type AuxiliaryRunOptions = {
  tui: Tui;
  onRunStart: () => void;
  onRunEnd: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
};

// A user-started run outside the Agent, such as a local shell command or
// manual memory compaction. One may be active at a time per owner; the task
// returns the final status phase.
export class AuxiliaryRun {
  private controller?: AbortController;

  constructor(private readonly options: AuxiliaryRunOptions) {}

  get active(): boolean {
    return this.controller !== undefined;
  }

  abort(): boolean {
    if (!this.controller) {
      return false;
    }
    this.controller.abort();
    this.options.updateStatus("aborted");
    return true;
  }

  async run(activeTool: string, task: (signal: AbortSignal) => Promise<RunPhase>): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.options.onRunStart();
    this.options.updateStatus("tool", { activeTool });
    this.options.tui.requestRender();
    try {
      this.options.updateStatus(await task(controller.signal));
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
      }
      this.options.onRunEnd();
      this.options.tui.requestRender();
    }
  }
}
