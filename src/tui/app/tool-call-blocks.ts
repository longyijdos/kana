import type { AssistantMessage, ToolCallContent } from "@/core";
import { ToolCallBlock, type Transcript } from "../components";
import { formatExplorationToolActivity } from "../tools";

export class ToolCallBlocks {
  private readonly preparedCalls = new Map<string, ToolCallContent>();
  private readonly runningBlocks = new Map<string, ToolCallBlock>();

  constructor(private readonly transcript: Transcript) {}

  clear(): void {
    this.stopTimers();
    this.preparedCalls.clear();
    this.runningBlocks.clear();
    this.transcript.finishExplorationPhase();
  }

  discardPrepared(): void {
    this.preparedCalls.clear();
  }

  registerFromMessage(message: AssistantMessage): void {
    for (const content of message.content) {
      if (content.type === "tool_call") {
        this.register(content);
      }
    }
  }

  register(toolCall: ToolCallContent): void {
    this.preparedCalls.set(toolCall.id, structuredClone(toolCall));
    this.finishPriorExplorationFor(toolCall);
  }

  noteCallStreamStarted(toolCall: ToolCallContent): void {
    this.finishPriorExplorationFor(toolCall);
  }

  hasActiveTimers(): boolean {
    return [...this.runningBlocks.values()].some((block) => block.hasActiveTimer());
  }

  stopTimers(): void {
    for (const block of this.runningBlocks.values()) {
      block.stopTimer();
    }
  }

  markActiveCanceled(): void {
    for (const block of this.runningBlocks.values()) {
      block.markCanceled();
    }
  }

  markStarted(toolCallId: string, toolName: string, args: unknown): void {
    const existing = this.runningBlocks.get(toolCallId);
    if (existing) {
      existing.updateArgs(args);
      return;
    }

    const toolCall = this.preparedCalls.get(toolCallId) ?? {
      type: "tool_call",
      id: toolCallId,
      name: toolName,
      args,
    };
    const block = new ToolCallBlock(toolCall);
    block.updateArgs(args);
    block.markExecutionStarted();
    this.preparedCalls.delete(toolCallId);
    this.runningBlocks.set(toolCallId, block);
    this.addBlock(block);
  }

  updatePartialResult(toolCallId: string, result: unknown): void {
    this.runningBlocks.get(toolCallId)?.updatePartialResult(result);
  }

  updateResult(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    let block = this.runningBlocks.get(toolCallId);

    if (block) {
      block.updateResult(result, isError);
    } else {
      // Validation, approval, or cancellation can finish a fully parsed call
      // before execution_start. Keep the terminal outcome visible without
      // exposing a provisional tool block.
      const toolCall = this.preparedCalls.get(toolCallId) ?? {
        type: "tool_call",
        id: toolCallId,
        name: toolName,
        args: undefined,
      };
      block = new ToolCallBlock(toolCall);
      block.updateResult(result, isError);
      this.addBlock(block);
    }

    const activity = block.getExplorationActivity();
    if (activity?.state === "canceled") {
      this.transcript.cancelExplorationPhase();
    } else if (isError && activity === undefined) {
      this.transcript.finishExplorationPhase();
    }
    this.preparedCalls.delete(toolCallId);
    this.runningBlocks.delete(toolCallId);
    this.finishExplorationBeforeNextPreparedCall();
  }

  private addBlock(block: ToolCallBlock): void {
    if (block.getExplorationActivity()) {
      this.transcript.startExplorationPhase();
    } else {
      this.transcript.finishExplorationPhase();
    }
    this.transcript.addChild(block);
  }

  private finishPriorExplorationFor(toolCall: ToolCallContent): void {
    // A non-exploration call is a semantic boundary as soon as its name is
    // known. Waiting for execution_start would incorrectly include approval
    // and queue time in the preceding Explore timer.
    if (toolCall.name && !formatExplorationToolActivity(toolCall)) {
      this.transcript.finishExplorationPhase();
    }
  }

  private finishExplorationBeforeNextPreparedCall(): void {
    if (this.runningBlocks.size > 0) {
      return;
    }

    const nextCall = this.preparedCalls.values().next().value;
    if (nextCall) {
      this.finishPriorExplorationFor(nextCall);
    }
  }
}
