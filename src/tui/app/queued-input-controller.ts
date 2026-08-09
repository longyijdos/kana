import type { UserMessage } from "@/core";
import type { ConversationInputQueueSnapshot } from "@/kana";
import type { EditorQueuedInput, EditorScheduledInputSummary } from "../components";

type QueuedTurnInput = {
  id: number;
  input: UserMessage;
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

  addTurn(input: UserMessage | string): number {
    const id = ++this.nextId;
    this.turnInputs.push({
      id,
      input: typeof input === "string" ? { role: "user", content: input } : structuredClone(input),
    });
    this.publish();
    return id;
  }

  remove(id: number): void {
    this.removeAt(this.turnInputs.findIndex((input) => input.id === id));
  }

  syncRuntimeQueue(queue: ConversationInputQueueSnapshot): void {
    // Runtime publishes a deferred fallback before the awaiting Enter handler resumes.
    // Runtime IDs make each fallback reconcile once; pairing it with the local preview
    // still relies on content and FIFO ordering until correlation IDs span both layers.
    for (const pending of queue.pending) {
      if (pending.kind !== "deferred" || this.observedDeferredInputIds.has(pending.id)) {
        continue;
      }
      this.observedDeferredInputIds.add(pending.id);
      const turnIndex = this.turnInputs.findIndex(
        ({ input }) =>
          input.content === pending.content &&
          (input.images?.length ?? 0) === (pending.imageCount ?? 0),
      );
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
      imageCount: pending.imageCount,
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

  deliverTurn(input: UserMessage): void {
    this.removeAt(
      this.turnInputs.findIndex(
        (queued) =>
          queued.input.content === input.content &&
          (queued.input.images?.length ?? 0) === (input.images?.length ?? 0),
      ),
    );
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
      ...this.turnInputs.map(({ input }) => ({
        content: input.content,
        imageCount: input.images?.length,
        delivery: "turn" as const,
      })),
      ...this.runtimeInputs,
    ];
    this.onChanged(ordered, this.scheduled);
  }
}
