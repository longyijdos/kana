import type { AssistantMessage, ToolCallContent } from "@/core";
import type { KanaTodoItem } from "@/kana";
import { ToolCallBlock, ToolPreparationBlock, type Transcript } from "../components";

export class ToolCallBlocks {
  private readonly pendingTools = new Map<string, ToolCallBlock>();
  // Streamed calls stay detached from the transcript until approval, execution,
  // or a terminal result establishes an actual per-tool lifecycle boundary.
  private readonly knownToolCalls = new Map<string, ToolCallContent>();
  private preparationBlock?: ToolPreparationBlock;

  constructor(private readonly transcript: Transcript) {}

  clear(): void {
    this.stopTimers();
    this.removePreparation();
    this.pendingTools.clear();
    this.knownToolCalls.clear();
  }

  hasActiveTimers(): boolean {
    return (
      this.preparationBlock?.hasActiveTimer() === true ||
      [...this.pendingTools.values()].some((block) => block.hasActiveTimer())
    );
  }

  stopTimers(): void {
    this.preparationBlock?.stopTimer();
    for (const block of this.pendingTools.values()) {
      block.stopTimer();
    }
  }

  markPendingCanceled(): void {
    this.finishPreparation();
    for (const block of this.pendingTools.values()) {
      block.markCanceled();
    }
    this.knownToolCalls.clear();
  }

  createOrUpdateFromMessage(message: AssistantMessage): void {
    let hasToolCall = false;

    for (const content of message.content) {
      if (content.type !== "tool_call") {
        continue;
      }

      hasToolCall = true;
      this.knownToolCalls.set(content.id, structuredClone(content));
      this.pendingTools.get(content.id)?.updateArgs(content.args);
    }

    if (hasToolCall && !this.preparationBlock && this.pendingTools.size === 0) {
      this.preparationBlock = new ToolPreparationBlock();
      this.transcript.addChild(this.preparationBlock);
    }
  }

  markStarted(toolCallId: string, toolName: string, args: unknown): void {
    this.finishPreparation();
    const block = this.getOrCreate(toolCallId, toolName, args);

    block.markExecutionStarted();
  }

  stopPreparationTimer(): void {
    this.preparationBlock?.stopTimer();
  }

  markPreparationPrepared(): void {
    this.preparationBlock?.markPrepared();
  }

  finishPreparation(): void {
    this.removePreparation();
  }

  updatePartialResult(toolCallId: string, result: unknown): void {
    this.pendingTools.get(toolCallId)?.updatePartialResult(result);
  }

  updateTodoState(toolCallId: string, items: readonly KanaTodoItem[]): void {
    this.pendingTools.get(toolCallId)?.updateTodoState(items);
  }

  updateResult(toolCallId: string, result: unknown, isError: boolean): void {
    this.finishPreparation();
    const toolCall = this.knownToolCalls.get(toolCallId);
    const block =
      this.pendingTools.get(toolCallId) ??
      (toolCall ? this.getOrCreate(toolCall.id, toolCall.name, toolCall.args) : undefined);
    block?.updateResult(result, isError);
    this.pendingTools.delete(toolCallId);
    this.knownToolCalls.delete(toolCallId);
  }

  private getOrCreate(toolCallId: string, toolName: string, args: unknown): ToolCallBlock {
    let block = this.pendingTools.get(toolCallId);

    if (!block) {
      const knownToolCall = this.knownToolCalls.get(toolCallId);
      const toolCall: ToolCallContent = knownToolCall
        ? { ...structuredClone(knownToolCall), args }
        : {
            type: "tool_call",
            id: toolCallId,
            name: toolName,
            args,
          };
      block = new ToolCallBlock(toolCall);
      this.pendingTools.set(toolCallId, block);
      this.transcript.addChild(block);
    }

    return block;
  }

  private removePreparation(): void {
    if (!this.preparationBlock) {
      return;
    }

    this.preparationBlock.stopTimer();
    this.transcript.removeChild(this.preparationBlock);
    this.preparationBlock = undefined;
  }
}
