import type { BeforeToolExecutionResult } from "@/agent";
import type { ToolCallContent } from "@/core";
import {
  type ConversationAgentIdentity,
  getBashCommand,
  type KanaToolApprovalConfig,
  type KanaToolApprovalMode,
  type KanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";
import { type Editor, ToolApproval, type ToolApprovalDecision } from "../components";
import type { Component, Tui } from "../runtime";
import type { ToolApprovalSource } from "../tools";
import type { BottomAreaController } from "./bottom-area-controller";

export type ToolApprovalControllerOptions = {
  config: KanaToolApprovalConfig;
  approvals: KanaToolApprovals;
  addTrustedBashCommand: (command: string) => KanaToolApprovals;
  editor: Editor;
  bottomArea: BottomAreaController;
  tui: Tui;
  resolveToolSource?: (toolName: string) => ToolApprovalSource | undefined;
  onApprovalRequired: (toolName: string, agent: ConversationAgentIdentity) => void;
};

type PendingApproval = {
  toolCall: ToolCallContent;
  signal?: AbortSignal;
  agent: ConversationAgentIdentity;
  resolve: (result: BeforeToolExecutionResult) => void;
  settled: boolean;
  onAbort: () => void;
  component?: ToolApproval;
};

export class ToolApprovalController {
  private approvals: KanaToolApprovals;
  // Keep the session override separate from configured policy and persistent
  // command trust; the app clears it at every session lifecycle boundary.
  private temporaryMode?: KanaToolApprovalMode;

  constructor(private readonly options: ToolApprovalControllerOptions) {
    this.approvals = options.approvals;
  }

  get activePrompt(): Component | undefined {
    return this.active?.component;
  }

  get mode(): KanaToolApprovalMode {
    return this.temporaryMode ?? this.options.config.mode;
  }

  setTemporaryMode(mode: KanaToolApprovalMode): void {
    this.temporaryMode = mode === this.options.config.mode ? undefined : mode;
  }

  resetTemporaryMode(): KanaToolApprovalMode | undefined {
    const previousMode = this.temporaryMode;
    this.temporaryMode = undefined;
    return previousMode;
  }

  private readonly pending: PendingApproval[] = [];
  private active?: PendingApproval;

  request(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
    agent: ConversationAgentIdentity = { id: "main", label: "main", kind: "main" },
  ): Promise<BeforeToolExecutionResult> {
    if (!shouldRequestToolApproval({ mode: this.mode }, this.approvals, toolCall)) {
      return Promise.resolve({ type: "continue" });
    }

    return new Promise((resolve) => {
      const pending = {
        toolCall: structuredClone(toolCall),
        signal,
        agent: { ...agent },
        resolve,
        settled: false,
        onAbort: () => {},
      } satisfies PendingApproval;
      pending.onAbort = () => this.finish(pending, "no");
      if (signal?.aborted) {
        this.finish(pending, "no");
        return;
      }
      this.pending.push(pending);
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      this.activateNext();
      this.options.onApprovalRequired(toolCall.name, agent);
    });
  }

  private activateNext(): void {
    if (this.active || this.pending.length === 0) return;
    const pending = this.pending[0] as PendingApproval;
    const bashCommand = getBashCommand(pending.toolCall);
    const source = this.options.resolveToolSource?.(pending.toolCall.name);
    pending.component = new ToolApproval(
      pending.toolCall,
      (decision) => this.finish(pending, decision),
      {
        allowAlways: bashCommand !== undefined,
        requesterLabel: pending.agent.kind === "subagent" ? pending.agent.label : undefined,
        ...(source === undefined ? {} : { source }),
      },
    );
    this.active = pending;
    if (this.options.bottomArea.isShowing(this.options.editor)) {
      this.options.bottomArea.show(pending.component);
    }
    this.options.tui.requestRender();
  }

  private finish(pending: PendingApproval, decision: ToolApprovalDecision): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.signal?.removeEventListener("abort", pending.onAbort);
    const index = this.pending.indexOf(pending);
    if (index >= 0) this.pending.splice(index, 1);
    const wasActive = this.active === pending;
    const component = pending.component;
    const restoreFocus = component ? this.options.bottomArea.hasFocus(component) : false;
    if (wasActive) {
      this.active = undefined;
      this.activateNext();
      if (component) this.options.bottomArea.restore(component, restoreFocus);
    }

    const bashCommand = getBashCommand(pending.toolCall);
    if (decision === "always" && bashCommand !== undefined) {
      this.approvals = this.options.addTrustedBashCommand(bashCommand);
    }
    pending.resolve(
      decision === "yes" || decision === "always"
        ? { type: "continue" }
        : { type: "cancel", abortRun: true, message: "Tool call rejected by user." },
    );
    this.options.tui.requestRender();
  }
}
