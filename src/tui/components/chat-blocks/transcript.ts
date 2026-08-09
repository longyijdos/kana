import type { Component } from "../../runtime";
import { AssistantMessageBlock } from "./assistant-message-block";
import { renderToolActivityGroup, type ToolActivityItem } from "./tool-activity-group";
import { ToolCallBlock } from "./tool-call-block";

type TranscriptOptions = {
  groupToolCalls?: boolean;
};

export class Transcript implements Component {
  readonly children: Component[] = [];

  constructor(private readonly options: TranscriptOptions = {}) {}

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

  render(width: number, availableHeight?: number): string[] {
    const lines: string[] = [];
    let hasRenderedChild = false;
    let explorationItems: ToolActivityItem[] = [];

    const appendLines = (childLines: string[]): void => {
      if (childLines.length === 0) {
        return;
      }

      if (hasRenderedChild) {
        lines.push("");
      }

      lines.push(...childLines);
      hasRenderedChild = true;
    };
    const flushExploration = (): void => {
      if (explorationItems.length === 0) {
        return;
      }

      appendLines(
        renderToolActivityGroup(
          explorationItems,
          {
            active: "Exploring",
            done: "Explored",
            canceled: "Exploration stopped",
          },
          width,
        ),
      );
      explorationItems = [];
    };

    for (const child of this.children) {
      if (
        this.options.groupToolCalls !== false &&
        child instanceof AssistantMessageBlock &&
        child.startsLocalToolBatch()
      ) {
        flushExploration();
      }

      if (this.options.groupToolCalls !== false && child instanceof ToolCallBlock) {
        const activity = child.getExplorationActivity();
        if (activity) {
          explorationItems.push(activity);
          continue;
        }
      }

      const childLines = child.render(width, availableHeight);

      if (childLines.length === 0) {
        continue;
      }

      flushExploration();
      appendLines(childLines);
    }

    flushExploration();

    return lines;
  }
}
