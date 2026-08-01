import type { BeforeToolExecutionResult } from "@/agent";
import type { ToolCallContent } from "@/core";
import {
  addTrustedBashCommand,
  getBashCommand,
  type KanaToolApprovalConfig,
  type KanaToolApprovalMode,
  type KanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";
import { type Editor, ToolApproval, type ToolApprovalDecision } from "../components";
import type { Component, Tui } from "../runtime";
import type { ToolApprovalSource } from "../tools";
import type { AppLayout } from "./app-layout";

export type ToolApprovalControllerOptions = {
  config: KanaToolApprovalConfig;
  approvals: KanaToolApprovals;
  editor: Editor;
  layout: AppLayout;
  tui: Tui;
  resolveToolSource?: (toolName: string) => ToolApprovalSource | undefined;
  onApprovalRequired: (toolName: string) => void;
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
    return this.activeApproval;
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

  private activeApproval?: ToolApproval;

  request(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    if (!shouldRequestToolApproval({ mode: this.mode }, this.approvals, toolCall)) {
      return Promise.resolve({ type: "continue" });
    }

    return new Promise((resolve) => {
      let approval: ToolApproval | undefined;
      let settled = false;
      const bashCommand = getBashCommand(toolCall);
      const source = this.options.resolveToolSource?.(toolCall.name);

      const finish = (decision: ToolApprovalDecision): void => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener("abort", handleAbort);
        const finishedApproval = approval;

        if (finishedApproval) {
          if (this.options.layout.isBottom(finishedApproval)) {
            this.options.layout.showBottom(this.options.editor);
          }
          if (this.activeApproval === finishedApproval) {
            this.activeApproval = undefined;
          }
          approval = undefined;
        }

        if (this.options.tui.getFocus() === finishedApproval) {
          this.options.tui.setFocus(this.options.editor);
        }
        this.options.tui.requestRender();

        if (decision === "always" && bashCommand !== undefined) {
          this.approvals = addTrustedBashCommand(bashCommand);
        }

        resolve(
          decision === "yes" || decision === "always"
            ? { type: "continue" }
            : {
                type: "cancel",
                abortRun: true,
                message: "Tool call rejected by user.",
              },
        );
      };

      const handleAbort = (): void => {
        finish("no");
      };

      if (signal?.aborted) {
        handleAbort();
        return;
      }

      approval = new ToolApproval(toolCall, finish, {
        allowAlways: bashCommand !== undefined,
        ...(source === undefined ? {} : { source }),
      });
      this.activeApproval = approval;
      // Keep another bottom view in place; the approval notification announces this pending prompt.
      if (this.options.layout.isBottom(this.options.editor)) {
        this.options.layout.showBottom(approval);
        this.options.tui.setFocus(approval);
      }
      signal?.addEventListener("abort", handleAbort, { once: true });
      this.options.onApprovalRequired(toolCall.name);
      this.options.tui.requestRender();
    });
  }
}
