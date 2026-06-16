import type { AssistantMessage, ToolCallContent } from "@/core";
import { ToolCallBlock, type Transcript } from "../components";

export class ToolCallBlocks {
  private readonly pendingTools = new Map<string, ToolCallBlock>();

  constructor(private readonly transcript: Transcript) {}

  clear(): void {
    this.pendingTools.clear();
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
        this.transcript.addChild(block);
      } else {
        block.updateArgs(content.args);
      }
    }
  }

  markStarted(toolCallId: string, toolName: string, args: unknown): void {
    const block = this.getOrCreate(toolCallId, toolName, args);

    block.markExecutionStarted();
  }

  updatePartialResult(toolCallId: string, result: unknown): void {
    this.pendingTools.get(toolCallId)?.updatePartialResult(result);
  }

  updateResult(toolCallId: string, result: unknown, isError: boolean): void {
    this.pendingTools.get(toolCallId)?.updateResult(result, isError);
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
      this.transcript.addChild(block);
    }

    return block;
  }
}
