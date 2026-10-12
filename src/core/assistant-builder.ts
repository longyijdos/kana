import {
  type AssistantContent,
  type AssistantMessage,
  createMessageIdentity,
  type TextContent,
  type ThinkingContent,
} from "./messages";

// Builds one streamed assistant message. Each change replaces the affected
// content block instead of mutating it, so a snapshot only copies the block
// list and earlier snapshots keep their values while streaming continues.
export class AssistantMessageBuilder {
  private readonly identity = createMessageIdentity({ kind: "model_output" });
  private readonly blocks: AssistantContent[] = [];

  get content(): readonly AssistantContent[] {
    return this.blocks;
  }

  add(block: AssistantContent): number {
    this.blocks.push(block);
    return this.blocks.length - 1;
  }

  // The caller tracks which kind of block lives at `index`.
  update<T extends AssistantContent>(index: number, change: (block: T) => T): T {
    const updated = change(this.blocks[index] as T);
    this.blocks[index] = updated;
    return updated;
  }

  appendText(index: number, delta: string): void {
    this.update<TextContent | ThinkingContent>(index, (block) => ({
      ...block,
      text: block.text + delta,
    }));
  }

  snapshot(): AssistantMessage {
    return { ...this.identity, role: "assistant", content: [...this.blocks] };
  }
}
