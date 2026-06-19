import type { Component } from "../../runtime";
import { ToolCallBlock } from "./tool-call-block";

export class Transcript implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);

    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }

  clear(): void {
    this.children.length = 0;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const hintedTool = this.latestInspectableTool();

    for (const child of this.children) {
      if (child instanceof ToolCallBlock) {
        child.setOutputHintVisible(child === hintedTool);
      }

      lines.push(...child.render(width));
    }

    return lines;
  }

  private latestInspectableTool(): ToolCallBlock | undefined {
    for (let index = this.children.length - 1; index >= 0; index -= 1) {
      const child = this.children[index];

      if (child instanceof ToolCallBlock && child.hasExpandableOutput()) {
        return child;
      }
    }

    return undefined;
  }
}
