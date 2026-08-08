import type { ConversationInputQueueSnapshot } from "@/kana";
import type { EditorQueuedInput, EditorScheduledInputSummary } from "../components";

type QueuedTurnInput = {
  id: number;
  content: string;
};

export class QueuedInputController {
  private readonly turnInputs: QueuedTurnInput[] = [];
  private runtimeInputs: EditorQueuedInput[] = [];
  private scheduled?: EditorScheduledInputSummary;
  private readonly observedDeferredInputIds = new Set<string>();
  private nextId = 0;

  constructor(
    private readonly onChanged: (
      inputs: EditorQueuedInput[],
      scheduled?: EditorScheduledInputSummary,
    ) => void,
  ) {}

  addTurn(content: string): number {
    const id = ++this.nextId;
    this.turnInputs.push({ id, content });
    this.publish();
    return id;
  }

  remove(id: number): void {
    this.removeAt(this.turnInputs.findIndex((input) => input.id === id));
  }

  syncRuntimeQueue(queue: ConversationInputQueueSnapshot): void {
    // Runtime publishes a deferred fallback before the awaiting Enter handler
    // resumes, so reconcile it by stable queue ID instead of briefly showing
    // the same input in both delivery lanes.
    for (const pending of queue.pending) {
      if (pending.kind !== "deferred" || this.observedDeferredInputIds.has(pending.id)) {
        continue;
      }
      this.observedDeferredInputIds.add(pending.id);
      const turnIndex = this.turnInputs.findIndex((input) => input.content === pending.content);
      if (turnIndex >= 0) {
        this.turnInputs.splice(turnIndex, 1);
      }
    }
    const pendingIds = new Set(queue.pending.map((pending) => pending.id));
    for (const id of this.observedDeferredInputIds) {
      if (!pendingIds.has(id)) {
        this.observedDeferredInputIds.delete(id);
      }
    }

    this.runtimeInputs = queue.pending.map((pending) => ({
      content: pending.content,
      delivery: pending.kind === "scheduled" ? "scheduled" : "run",
    }));
    const nextScheduled = queue.scheduled[0];
    this.scheduled = nextScheduled
      ? {
          count: queue.scheduled.length,
          nextAt: nextScheduled.dueAt,
        }
      : undefined;
    this.publish();
  }

  deliverTurn(content: string): void {
    this.removeAt(this.turnInputs.findIndex((input) => input.content === content));
  }

  clear(): void {
    if (this.turnInputs.length === 0 && this.runtimeInputs.length === 0 && !this.scheduled) {
      return;
    }
    this.turnInputs.length = 0;
    this.runtimeInputs = [];
    this.scheduled = undefined;
    this.observedDeferredInputIds.clear();
    this.publish();
  }

  private removeAt(index: number): void {
    if (index < 0) {
      return;
    }
    this.turnInputs.splice(index, 1);
    this.publish();
  }

  private publish(): void {
    const ordered = [
      ...this.turnInputs.map(({ content }) => ({ content, delivery: "turn" as const })),
      ...this.runtimeInputs,
    ];
    this.onChanged(ordered, this.scheduled);
  }
}
