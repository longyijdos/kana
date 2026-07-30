import type { AssistantMessage } from "@/core";
import { graphemeSegments } from "../render";

const REVEAL_INTERVAL_MS = 16;
const BACKLOG_GRAPHEMES_PER_RATE_STEP = 16;
const MAX_GRAPHEMES_PER_FRAME = 4;
const COMPLETION_RATE_BOOST = 1;

type StreamingTextPresenterOptions = {
  onUpdate: (message: AssistantMessage, complete: boolean) => void;
  onSettled: () => void;
  requestRender: () => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

// Provider and Agent state always advance immediately. This presenter owns only
// the visible text prefix so transport-level SSE bursts can unfold across
// terminal frames without introducing backpressure into the model stream.
export class StreamingTextPresenter {
  private target?: AssistantMessage;
  private readonly visibleTextByIndex = new Map<number, string>();
  private complete = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly schedule: NonNullable<StreamingTextPresenterOptions["schedule"]>;
  private readonly cancel: NonNullable<StreamingTextPresenterOptions["cancel"]>;

  constructor(private readonly options: StreamingTextPresenterOptions) {
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
  }

  start(message: AssistantMessage): void {
    this.clearTimer();
    this.target = structuredClone(message);
    this.visibleTextByIndex.clear();
    for (const [index, content] of message.content.entries()) {
      if (content.type === "text") {
        this.visibleTextByIndex.set(index, content.text);
      }
    }
    this.complete = false;
    this.publish(false);
  }

  update(message: AssistantMessage, animateText: boolean): void {
    this.setTarget(message);
    if (!this.hasPendingText()) {
      this.publish(false);
      return;
    }

    if (!animateText) {
      this.publish(false);
      this.ensureTimer();
      return;
    }
    if (this.timer !== undefined) {
      return;
    }

    // Let an isolated provider delta appear immediately. The cooldown timer
    // then collects any sibling deltas delivered in the same body read.
    this.revealFrame();
    this.ensureTimer(true);
  }

  finish(message: AssistantMessage): void {
    this.setTarget(message);
    this.complete = true;
    if (!this.hasPendingText()) {
      this.settle();
      return;
    }

    if (this.timer === undefined) {
      this.revealFrame();
      if (this.hasPendingText()) {
        this.ensureTimer();
      }
    }
  }

  flush(): void {
    if (!this.target) {
      this.clearTimer();
      return;
    }

    for (const [index, content] of this.target.content.entries()) {
      if (content.type === "text") {
        this.visibleTextByIndex.set(index, content.text);
      }
    }
    this.complete = true;
    this.settle();
  }

  private setTarget(message: AssistantMessage): void {
    this.target = structuredClone(message);
    const textIndexes = new Set<number>();

    for (const [index, content] of this.target.content.entries()) {
      if (content.type !== "text") {
        continue;
      }
      textIndexes.add(index);
      const visible = this.visibleTextByIndex.get(index) ?? "";
      this.visibleTextByIndex.set(index, commonGraphemePrefix(visible, content.text));
    }

    for (const index of this.visibleTextByIndex.keys()) {
      if (!textIndexes.has(index)) {
        this.visibleTextByIndex.delete(index);
      }
    }
  }

  private revealFrame(): void {
    if (!this.target) {
      return;
    }

    let budget = this.frameBudget();
    for (const [index, content] of this.target.content.entries()) {
      if (budget <= 0 || content.type !== "text") {
        continue;
      }
      const visible = this.visibleTextByIndex.get(index) ?? "";
      const remaining = graphemeSegments(content.text.slice(visible.length));
      if (remaining.length === 0) {
        continue;
      }
      const revealed = remaining.slice(0, budget).map(({ segment }) => segment);
      this.visibleTextByIndex.set(index, visible + revealed.join(""));
      budget -= revealed.length;
    }

    if (this.complete && !this.hasPendingText()) {
      this.settle();
      return;
    }
    this.publish(false);
  }

  private frameBudget(): number {
    const remaining = this.pendingGraphemeCount();
    // Keep small backlogs at a stable typewriter-like rate, then accelerate in
    // bounded steps so a burst cannot create either a long tail or a large jump.
    const backlogRate = Math.max(1, Math.ceil(remaining / BACKLOG_GRAPHEMES_PER_RATE_STEP));
    const completionBoost = this.complete ? COMPLETION_RATE_BOOST : 0;
    return Math.min(MAX_GRAPHEMES_PER_FRAME, backlogRate + completionBoost);
  }

  private pendingGraphemeCount(): number {
    if (!this.target) {
      return 0;
    }
    let count = 0;
    for (const [index, content] of this.target.content.entries()) {
      if (content.type !== "text") {
        continue;
      }
      const visible = this.visibleTextByIndex.get(index) ?? "";
      count += graphemeSegments(content.text.slice(visible.length)).length;
    }
    return count;
  }

  private hasPendingText(): boolean {
    return this.pendingGraphemeCount() > 0;
  }

  private ensureTimer(cooldown = false): void {
    if (this.timer !== undefined) {
      return;
    }
    if (!cooldown && !this.hasPendingText()) {
      if (this.complete) {
        this.settle();
      }
      return;
    }

    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (this.hasPendingText()) {
        this.revealFrame();
      }
      if (this.hasPendingText()) {
        this.ensureTimer();
      } else if (this.complete) {
        this.settle();
      }
    }, REVEAL_INTERVAL_MS);
  }

  private publish(complete: boolean): void {
    if (!this.target) {
      return;
    }
    const visible = structuredClone(this.target);
    for (const [index, content] of visible.content.entries()) {
      if (content.type === "text") {
        content.text = this.visibleTextByIndex.get(index) ?? "";
      }
    }
    this.options.onUpdate(visible, complete);
    this.options.requestRender();
  }

  private settle(): void {
    if (!this.target) {
      return;
    }
    this.clearTimer();
    this.publish(true);
    this.target = undefined;
    this.visibleTextByIndex.clear();
    this.complete = false;
    this.options.onSettled();
  }

  private clearTimer(): void {
    if (this.timer === undefined) {
      return;
    }
    this.cancel(this.timer);
    this.timer = undefined;
  }
}

function commonGraphemePrefix(current: string, target: string): string {
  if (target.startsWith(current)) {
    return current;
  }

  let prefix = "";
  for (const { segment } of graphemeSegments(target)) {
    const candidate = prefix + segment;
    if (!current.startsWith(candidate)) {
      break;
    }
    prefix = candidate;
  }
  return prefix;
}
