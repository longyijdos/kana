import type { BeforeToolExecutionResult } from "@/agent";
import type { ToolCallContent } from "@/core";
import {
  addTrustedBashCommand,
  getBashCommand,
  type KanaToolApprovalConfig,
  type KanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";
import { type Editor, ToolApproval, type ToolApprovalDecision } from "../components";
import type { Tui } from "../runtime";
import type { AppLayout } from "./app-layout";

export type ToolApprovalControllerOptions = {
  config: KanaToolApprovalConfig;
  approvals: KanaToolApprovals;
  editor: Editor;
  layout: AppLayout;
  tui: Tui;
  onPromptShown: (toolName: string) => void;
};

export class ToolApprovalController {
  private approvals: KanaToolApprovals;

  constructor(private readonly options: ToolApprovalControllerOptions) {
    this.approvals = options.approvals;
  }

  request(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    if (!shouldRequestToolApproval(this.options.config, this.approvals, toolCall)) {
      return Promise.resolve({ type: "continue" });
    }

    return new Promise((resolve) => {
      let approval: ToolApproval | undefined;
      let settled = false;
      const bashCommand = getBashCommand(toolCall);

      const finish = (decision: ToolApprovalDecision): void => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener("abort", handleAbort);

        if (approval) {
          this.options.layout.clearInlinePrompt(approval);
          approval = undefined;
        }

        this.options.tui.setFocus(this.options.editor);
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
      });
      this.options.layout.showInlinePrompt(approval);
      this.options.tui.setFocus(approval);
      signal?.addEventListener("abort", handleAbort, { once: true });
      this.options.onPromptShown(toolCall.name);
      this.options.tui.requestRender();
    });
  }
}
