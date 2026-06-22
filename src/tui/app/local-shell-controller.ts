import { createNoopLogger, type Logger } from "@/logging";
import { createBashTool, normalizeToolResult } from "@/tools";
import { type Editor, type StatusLineState, ToolCallBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import type { RunPhase } from "./status-phase";

export type LocalShellControllerOptions = {
  editor: Editor;
  transcript: Transcript;
  tui: Tui;
  setRunning: (running: boolean) => void;
  clearRunStatus: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
  logger?: Logger;
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
    (this.options.logger ?? createNoopLogger()).info("local_shell.abort_requested");
    return true;
  }

  async submit(command: string): Promise<void> {
    const shellCommand = command.trim();
    const logger = this.options.logger ?? createNoopLogger();

    if (!shellCommand) {
      return;
    }

    const abortController = new AbortController();
    const tool = createBashTool({ root: process.cwd() });
    const toolCall = {
      type: "tool_call",
      id: `local_shell_${++this.runId}`,
      name: "bash",
      args: {
        command: shellCommand,
      },
    } as const;
    const block = new ToolCallBlock(toolCall);

    this.options.editor.clear();
    this.options.transcript.addChild(block);
    this.abortController = abortController;
    this.options.setRunning(true);
    this.options.updateStatus("tool", {
      activeTool: "bash",
    });
    this.options.tui.requestRender();
    logger.debug("local_shell.started");

    try {
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
      if (result.isError) {
        logger.warn("local_shell.failed");
      } else {
        logger.debug("local_shell.ended");
      }
    } catch (error) {
      block.updateResult(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
      this.options.updateStatus(abortController.signal.aborted ? "aborted" : "error");
      logger.error("local_shell.failed", {
        aborted: abortController.signal.aborted,
        error,
      });
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
