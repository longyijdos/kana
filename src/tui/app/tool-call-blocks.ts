import type { AssistantMessage, ToolCallContent } from "@/core";
import { ToolCallBlock, type Transcript } from "../components";

export class ToolCallBlocks {
  private readonly pendingTools = new Map<string, ToolCallBlock>();

  constructor(private readonly transcript: Transcript) {}

  clear(): void {
    this.stopTimers();
    this.pendingTools.clear();
    this.transcript.finishExplorationPhase();
  }

  hasActiveTimers(): boolean {
    return [...this.pendingTools.values()].some((block) => block.hasActiveTimer());
  }

  stopTimers(): void {
    for (const block of this.pendingTools.values()) {
      block.stopTimer();
    }
  }

  markPendingCanceled(): void {
    for (const block of this.pendingTools.values()) {
      block.markCanceled();
    }
  }

  createOrUpdateFromMessage(message: AssistantMessage): void {
    for (const content of message.content) {
      if (content.type !== "tool_call") {
        continue;
      }

      let block = this.pendingTools.get(content.id);

      if (!block) {
        block = new ToolCallBlock(content);
        this.pendingTools.set(content.id, block);
        this.addBlock(block);
      } else {
        block.updateArgs(content.args);
      }
    }
  }

  markStarted(toolCallId: string, toolName: string, args: unknown): void {
    const block = this.getOrCreate(toolCallId, toolName, args);

    block.updateArgs(args);
    block.setTranscriptVisible(true);
    block.markExecutionStarted();
  }

  freezePreparation(toolCallId: string): void {
    const block = this.pendingTools.get(toolCallId);
    block?.setTranscriptVisible(true);
    block?.freezePreparation();
  }

  updatePartialResult(toolCallId: string, result: unknown): void {
    const block = this.pendingTools.get(toolCallId);
    block?.setTranscriptVisible(true);
    block?.updatePartialResult(result);
  }

  updateResult(toolCallId: string, result: unknown, isError: boolean): void {
    const block = this.pendingTools.get(toolCallId);
    block?.updateResult(result, isError);
    block?.setTranscriptVisible(true);
    const activity = block?.getExplorationActivity();
    if (activity?.state === "canceled") {
      this.transcript.cancelExplorationPhase();
    } else if (isError && activity === undefined) {
      this.transcript.finishExplorationPhase();
    }
    this.pendingTools.delete(toolCallId);
  }

  private getOrCreate(toolCallId: string, toolName: string, args: unknown): ToolCallBlock {
    let block = this.pendingTools.get(toolCallId);

    if (!block) {
      const toolCall: ToolCallContent = {
        type: "tool_call",
        id: toolCallId,
        name: toolName,
        args,
      };
      block = new ToolCallBlock(toolCall);
      this.pendingTools.set(toolCallId, block);
      this.addBlock(block);
    }

    return block;
  }

  private addBlock(block: ToolCallBlock): void {
    if (block.getExplorationActivity()) {
      // Start the phase immediately, but keep streamed arguments provisional.
      // The stable item appears only at toolcall_end or an execution fallback.
      if (this.transcript.startExplorationPhase()) {
        block.setTranscriptVisible(false);
      }
    } else {
      this.transcript.finishExplorationPhase();
    }
    this.transcript.addChild(block);
  }
}
