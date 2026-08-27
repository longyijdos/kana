import type { Agent } from "@/agent";
import { addModelUsage, type ModelUsage } from "@/core";
import type { Editor, StatusLineState } from "../components";
import { calculateContextUsedPercent } from "../utils/context-usage";
import type { RunPhase } from "./status-phase";

export type StatusProjectionControllerOptions = {
  editor: Editor;
  getAgentState: () => Agent["state"];
};

export class StatusProjectionController {
  private runActive = false;
  private totalUsage?: ModelUsage;

  constructor(private readonly options: StatusProjectionControllerOptions) {}

  get running(): boolean {
    return this.runActive;
  }

  startRun(): void {
    this.runActive = true;
  }

  finishRun(refreshContext = false): void {
    this.runActive = false;
    if (refreshContext) {
      this.updateContextUsage();
    }
    this.options.editor.updateStatus({
      running: false,
      activeTool: undefined,
    });
  }

  update(phase: RunPhase, extra: Partial<StatusLineState> = {}): void {
    this.options.editor.updateStatus({
      phase,
      running: this.runActive,
      ...extra,
    });
  }

  recordUsage(usage: ModelUsage | undefined): void {
    if (usage) {
      this.totalUsage = addModelUsage(this.totalUsage, usage);
    }
  }

  formatTotalUsage(): string | undefined {
    return this.totalUsage ? formatModelUsage(this.totalUsage) : undefined;
  }

  updateContextUsage(estimatedTokens?: number): void {
    const state = this.options.getAgentState();
    this.options.editor.updateStatus({
      contextUsedPercent: calculateContextUsedPercent(
        estimatedTokens ?? state.estimatedContextTokens,
        state.contextLimit ?? state.model.metadata.contextWindow,
      ),
    });
  }
}

function formatModelUsage(usage: ModelUsage): string {
  const cachedTokens = usage.promptCacheHitTokens ?? 0;
  const inputTokens = usage.promptCacheMissTokens ?? Math.max(0, usage.promptTokens - cachedTokens);

  return [
    `total=${formatInteger(usage.totalTokens)}`,
    `input=${formatInteger(inputTokens)}`,
    cachedTokens > 0 ? `(+ ${formatInteger(cachedTokens)} cached)` : undefined,
    `output=${formatInteger(usage.completionTokens)}`,
    usage.reasoningTokens === undefined
      ? undefined
      : `(reasoning ${formatInteger(usage.reasoningTokens)})`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}
