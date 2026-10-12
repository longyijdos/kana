import { createNoopLogger, type Logger } from "@/logging";
import { createShellTool, normalizeToolResult } from "@/tools";
import { formatError } from "@/utils";
import { type Editor, type StatusLineState, ToolCallBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { AuxiliaryRun } from "./auxiliary-run";
import type { RunPhase } from "./status-phase";

export type LocalShellControllerOptions = {
  editor: Editor;
  transcript: Transcript;
  tui: Tui;
  onRunStart: () => void;
  onRunEnd: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
  getLogger?: () => Logger;
};

export class LocalShellController {
  private readonly run: AuxiliaryRun;
  private runId = 0;

  constructor(private readonly options: LocalShellControllerOptions) {
    this.run = new AuxiliaryRun(options);
  }

  abort(): boolean {
    if (!this.run.abort()) {
      return false;
    }
    (this.options.getLogger ?? createNoopLogger)().info("local_shell.abort_requested");
    return true;
  }

  async submit(command: string): Promise<void> {
    const shellCommand = command.trim();
    const logger = (this.options.getLogger ?? createNoopLogger)();

    if (!shellCommand) {
      return;
    }

    const tool = createShellTool({ root: process.cwd() });
    const toolCall = {
      type: "tool_call",
      id: `local_shell_${++this.runId}`,
      name: "shell",
      args: {
        command: shellCommand,
      },
    } as const;
    const block = new ToolCallBlock(toolCall);

    this.options.editor.clear();
    this.options.transcript.addChild(block);
    logger.debug("local_shell.started");

    await this.run.run("shell", async (signal) => {
      try {
        block.markExecutionStarted();
        this.options.tui.requestRender();
        const executed = await tool.execute(
          { command: shellCommand },
          {
            toolCallId: toolCall.id,
            signal,
            update: (partialResult) => {
              block.updatePartialResult(partialResult);
              this.options.tui.requestRender();
            },
          },
        );
        const result = normalizeToolResult(executed);
        block.updateResult(result.result, result.isError ?? false);
        if (result.isError) {
          logger.warn("local_shell.failed");
          return "error";
        }
        logger.debug("local_shell.ended");
        return "done";
      } catch (error) {
        block.updateResult({ error: formatError(error) }, true);
        logger.error("local_shell.failed", { aborted: signal.aborted, error });
        return signal.aborted ? "aborted" : "error";
      }
    });
  }
}
