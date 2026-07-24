import { createNoopLogger, type Logger } from "@/logging";
import { type Editor, type StatusLineState, TextBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { RunPhase } from "./status-phase";

export type MemoryScope = "global" | "project" | "both";

export type MemoryCompactSummary = {
  target: Exclude<MemoryScope, "both">;
  outcome: "updated" | "unchanged" | "aborted" | "length" | "turn_limit" | "error";
  error?: string;
};

export type MemoryCompactControllerOptions = {
  editor: Editor;
  transcript: Transcript;
  tui: Tui;
  setRunning: (running: boolean) => void;
  clearRunStatus: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
  compactMemory: (
    target: MemoryScope,
    userRequest: string | undefined,
    signal: AbortSignal,
  ) => Promise<MemoryCompactSummary[]>;
  getLogger?: () => Logger;
};

export class MemoryCompactController {
  private abortController?: AbortController;

  constructor(private readonly options: MemoryCompactControllerOptions) {}

  abort(): boolean {
    if (!this.abortController) {
      return false;
    }

    this.abortController.abort();
    this.options.updateStatus("aborted");
    (this.options.getLogger ?? createNoopLogger)().info("memory_compact.abort_requested");
    return true;
  }

  async compact(target: MemoryScope, userRequest?: string): Promise<void> {
    if (this.abortController) {
      return;
    }

    const logger = (this.options.getLogger ?? createNoopLogger)();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.options.editor.clear();
    this.options.transcript.addChild(
      new TextBlock(`Compacting ${formatTarget(target)} memory…`, {
        color: tuiTheme.muted,
      }),
    );
    this.options.setRunning(true);
    this.options.updateStatus("tool", { activeTool: "memory" });
    this.options.tui.requestRender();
    logger.info("memory_compact.started", { target });

    try {
      const summaries = await this.options.compactMemory(
        target,
        userRequest,
        abortController.signal,
      );
      this.options.transcript.addChild(
        new TextBlock(formatSummaries(summaries), {
          color: summaries.some((summary) => summary.outcome === "error")
            ? tuiTheme.error
            : tuiTheme.muted,
        }),
      );
      this.options.updateStatus(
        summaries.some((summary) => summary.outcome === "error") ? "error" : "done",
      );
      logger.info("memory_compact.ended", {
        target,
        outcomes: summaries.map((summary) => summary.outcome),
      });
    } catch (error) {
      this.options.transcript.addChild(
        new TextBlock(error instanceof Error ? error.message : String(error), {
          color: tuiTheme.error,
        }),
      );
      this.options.updateStatus(abortController.signal.aborted ? "aborted" : "error");
      logger.error("memory_compact.failed", { target, error });
    } finally {
      if (this.abortController === abortController) {
        this.abortController = undefined;
      }
      this.options.setRunning(false);
      this.options.clearRunStatus();
      this.options.tui.requestRender();
    }
  }
}

function formatTarget(target: MemoryScope): string {
  return target === "both" ? "global and project" : target;
}

function formatSummaries(summaries: MemoryCompactSummary[]): string {
  const result = summaries
    .map((summary) =>
      summary.outcome === "error"
        ? `${summary.target} failed: ${summary.error ?? "unknown error"}`
        : `${summary.target} ${summary.outcome}`,
    )
    .join(", ");

  return `Memory compacted: ${result}.`;
}
