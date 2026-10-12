import { createNoopLogger, type Logger } from "@/logging";
import { formatError } from "@/utils";
import { type Editor, type StatusLineState, TextBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import { AuxiliaryRun } from "./auxiliary-run";
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
  onRunStart: () => void;
  onRunEnd: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
  compactMemory: (
    target: MemoryScope,
    userRequest: string | undefined,
    signal: AbortSignal,
  ) => Promise<MemoryCompactSummary[]>;
  getLogger?: () => Logger;
};

export class MemoryCompactController {
  private readonly run: AuxiliaryRun;

  constructor(private readonly options: MemoryCompactControllerOptions) {
    this.run = new AuxiliaryRun(options);
  }

  abort(): boolean {
    if (!this.run.abort()) {
      return false;
    }
    (this.options.getLogger ?? createNoopLogger)().info("memory_compact.abort_requested");
    return true;
  }

  async compact(target: MemoryScope, userRequest?: string): Promise<void> {
    if (this.run.active) {
      return;
    }

    const logger = (this.options.getLogger ?? createNoopLogger)();
    this.options.editor.clear();
    this.options.transcript.addChild(
      new TextBlock(`Compacting ${formatTarget(target)} memory…`, { color: tuiTheme.muted }),
    );
    logger.info("memory_compact.started", { target });

    await this.run.run("memory", async (signal) => {
      try {
        const summaries = await this.options.compactMemory(target, userRequest, signal);
        const failed = summaries.some((summary) => summary.outcome === "error");
        this.options.transcript.addChild(
          new TextBlock(formatSummaries(summaries), {
            color: failed ? tuiTheme.error : tuiTheme.muted,
          }),
        );
        logger.info("memory_compact.ended", {
          target,
          outcomes: summaries.map((summary) => summary.outcome),
        });
        return failed ? "error" : "done";
      } catch (error) {
        this.options.transcript.addChild(
          new TextBlock(formatError(error), { color: tuiTheme.error }),
        );
        logger.error("memory_compact.failed", { target, error });
        return signal.aborted ? "aborted" : "error";
      }
    });
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
