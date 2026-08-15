import { createUserMessage, type MessageId, type UserMessage } from "@/core";
import type { ConversationInputQueueSnapshot } from "@/kana";
import type { EditorQueuedInput, EditorScheduledInputSummary } from "../components";

type QueuedTurnInput = {
  input: UserMessage;
};

type RuntimeQueuedInput = EditorQueuedInput & { id: MessageId };

export class QueuedInputController {
  private readonly turnInputs: QueuedTurnInput[] = [];
  private runtimeInputs: RuntimeQueuedInput[] = [];
  private scheduled?: EditorScheduledInputSummary;

  constructor(
    private readonly onChanged: (
      inputs: EditorQueuedInput[],
      scheduled?: EditorScheduledInputSummary,
    ) => void,
  ) {}

  addTurn(input: UserMessage | string): MessageId {
    const message =
      typeof input === "string"
        ? createUserMessage({ content: input, provenance: { kind: "user_input" } })
        : structuredClone(input);
    this.turnInputs.push({
      input: message,
    });
    this.publish();
    return message.id;
  }

  remove(id: MessageId): void {
    const turnIndex = this.turnInputs.findIndex(({ input }) => input.id === id);
    if (turnIndex >= 0) {
      this.turnInputs.splice(turnIndex, 1);
    }
    const runtimeIndex = this.runtimeInputs.findIndex((input) => input.id === id);
    if (runtimeIndex >= 0) {
      this.runtimeInputs.splice(runtimeIndex, 1);
    }
    if (turnIndex >= 0 || runtimeIndex >= 0) {
      this.publish();
    }
  }

  syncRuntimeQueue(queue: ConversationInputQueueSnapshot): void {
    const pendingIds = new Set(queue.pending.map((pending) => pending.id));
    // Runtime may publish the accepted inbox item before the Enter handler
    // resumes. Identity lets that authoritative projection replace exactly its
    // optimistic preview even when several inputs have identical content.
    for (let index = this.turnInputs.length - 1; index >= 0; index -= 1) {
      const queued = this.turnInputs[index];
      if (queued && pendingIds.has(queued.input.id)) {
        this.turnInputs.splice(index, 1);
      }
    }

    this.runtimeInputs = queue.pending.map((pending) => ({
      id: pending.id,
      content: pending.content,
      imageCount: pending.imageCount,
      delivery:
        pending.kind === "scheduled" ? "scheduled" : pending.kind === "steering" ? "turn" : "run",
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
    this.remove(input.id);
  }

  clear(): void {
    if (this.turnInputs.length === 0 && this.runtimeInputs.length === 0 && !this.scheduled) {
      return;
    }
    this.turnInputs.length = 0;
    this.runtimeInputs = [];
    this.scheduled = undefined;
    this.publish();
  }

  private publish(): void {
    const ordered = [
      ...this.turnInputs.map(({ input }) => ({
        content: input.content,
        imageCount: input.images?.length,
        delivery: "turn" as const,
      })),
      ...this.runtimeInputs.map(({ id: _id, ...input }) => input),
    ];
    this.onChanged(ordered, this.scheduled);
  }
}
