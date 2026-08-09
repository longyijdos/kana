import type { Component } from "../../runtime";
import { type Clock, ElapsedTimer } from "../../utils/elapsed-timer";
import { AssistantMessageBlock } from "./assistant-message-block";
import {
  renderToolActivityGroup,
  type ToolActivityGroupState,
  type ToolActivityItem,
} from "./tool-activity-group";
import { ToolCallBlock } from "./tool-call-block";

type TranscriptOptions = {
  groupToolCalls?: boolean;
  now?: Clock;
};

type ExplorationPhase = {
  startIndex: number;
  state: ToolActivityGroupState;
  timer: ElapsedTimer;
};

export class Transcript implements Component {
  readonly children: Component[] = [];
  private readonly explorationPhases: ExplorationPhase[] = [];
  private activeExplorationPhase?: ExplorationPhase;

  constructor(private readonly options: TranscriptOptions = {}) {}

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);

    if (index >= 0) {
      this.children.splice(index, 1);
      for (const phase of this.explorationPhases) {
        if (index < phase.startIndex) {
          phase.startIndex -= 1;
        }
      }
    }
  }

  clear(): void {
    this.finishExplorationPhase();
    this.explorationPhases.length = 0;
    this.children.length = 0;
  }

  startExplorationPhase(): boolean {
    if (this.options.groupToolCalls === false) {
      return false;
    }
    if (this.activeExplorationPhase) {
      return true;
    }

    const timer = new ElapsedTimer(this.options.now);
    timer.start();
    const phase: ExplorationPhase = {
      startIndex: this.children.length,
      state: "active",
      timer,
    };
    this.explorationPhases.push(phase);
    this.activeExplorationPhase = phase;
    return true;
  }

  finishExplorationPhase(): void {
    this.settleExplorationPhase("done");
  }

  cancelExplorationPhase(): void {
    this.settleExplorationPhase("canceled");
  }

  hasActiveExplorationPhase(): boolean {
    return this.activeExplorationPhase !== undefined;
  }

  render(width: number, availableHeight?: number): string[] {
    const lines: string[] = [];
    let hasRenderedChild = false;
    let explorationItems: ToolActivityItem[] = [];
    let explorationPhase: ExplorationPhase | undefined;
    let explorationPhaseIndex = 0;

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
      if (explorationItems.length === 0 && !explorationPhase) {
        return;
      }

      appendLines(
        renderToolActivityGroup(
          explorationItems,
          {
            active: "Exploring",
            done: "Explored",
            canceled: "Exploration stopped",
            failed: "Exploration failed",
          },
          width,
          explorationPhase?.state === "active" || explorationPhase?.state === "canceled"
            ? {
                state: explorationPhase.state,
                elapsedSeconds: explorationPhase.timer.elapsedSeconds(),
              }
            : undefined,
        ),
      );
      explorationItems = [];
      explorationPhase = undefined;
    };

    for (let childIndex = 0; childIndex <= this.children.length; childIndex += 1) {
      while (this.explorationPhases[explorationPhaseIndex]?.startIndex === childIndex) {
        flushExploration();
        explorationPhase = this.explorationPhases[explorationPhaseIndex];
        explorationPhaseIndex += 1;
      }

      const child = this.children[childIndex];
      if (!child) {
        continue;
      }

      // Thinking-only assistant blocks between tool-use turns are transparent:
      // the active exploration group owns that phase's single visible status.
      if (
        this.options.groupToolCalls !== false &&
        child instanceof AssistantMessageBlock &&
        explorationPhase &&
        child.rendersOnlyThinking()
      ) {
        continue;
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

  private settleExplorationPhase(state: Exclude<ToolActivityGroupState, "active">): void {
    if (!this.activeExplorationPhase) {
      return;
    }

    this.activeExplorationPhase.state = state;
    this.activeExplorationPhase.timer.stop();
    this.activeExplorationPhase = undefined;
  }
}
