import type { BeforeToolExecutionResult } from "@/agent";
import type { ToolCallContent } from "@/core";
import { createBashTool, normalizeToolResult } from "@/tools";
import { type Editor, type StatusLineState, ToolCallBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import type { RunPhase } from "./status-phase";

export type LocalShellControllerOptions = {
  editor: Editor;
  transcript: Transcript;
  tui: Tui;
  requestApproval: (
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ) => Promise<BeforeToolExecutionResult>;
  setRunning: (running: boolean) => void;
  clearRunStatus: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
};

export class LocalShellController {
  private abortController?: AbortController;
  private runId = 0;

  constructor(private readonly options: LocalShellControllerOptions) {}

  abort(): boolean {
    if (!this.abortController) {
      return false;
    }

    this.abortController.abort();
    this.options.updateStatus("aborted");
    return true;
  }

  async submit(command: string, raw: string): Promise<void> {
    const shellCommand = command.trim();

    if (!shellCommand) {
      return;
    }

    const abortController = new AbortController();
    const tool = createBashTool({ root: process.cwd() });
    const toolCall: ToolCallContent = {
      type: "tool_call",
      id: `local_shell_${++this.runId}`,
      name: "bash",
      args: {
        command: shellCommand,
      },
    };
    const block = new ToolCallBlock(toolCall);

    this.options.editor.addToHistory(raw.trim());
    this.options.editor.clear();
    this.options.transcript.addChild(block);
    this.abortController = abortController;
    this.options.setRunning(true);
    this.options.updateStatus("tool", {
      activeTool: "bash",
    });
    this.options.tui.requestRender();

    try {
      const approval = await this.options.requestApproval(toolCall, abortController.signal);

      if (approval.type === "cancel") {
        block.updateResult(
          {
            error: approval.message ?? "Command canceled before execution.",
            canceled: true,
          },
          true,
        );
        this.options.updateStatus("aborted");
        return;
      }

      block.markExecutionStarted();
      this.options.tui.requestRender();

      const executed = await tool.execute(
        {
          command: shellCommand,
        },
        {
          toolCallId: toolCall.id,
          signal: abortController.signal,
          update: (partialResult) => {
            block.updatePartialResult(partialResult);
            this.options.tui.requestRender();
          },
        },
      );
      const result = normalizeToolResult(executed);

      block.updateResult(result.result, result.isError ?? false);
      this.options.updateStatus(result.isError ? "error" : "done");
    } catch (error) {
      block.updateResult(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
      this.options.updateStatus(abortController.signal.aborted ? "aborted" : "error");
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
