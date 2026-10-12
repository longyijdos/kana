import type { MessageId, UserMessage } from "@/core";

export type AgentInputLane = "next-step" | "next-turn";

export type AgentInputDelivery =
  | { kind: "steering" }
  | { kind: "queued" }
  | {
      readonly kind: "scheduled";
      readonly displayContent: string;
      readonly dueAt: Date;
      readonly origin: "user" | "agent";
      readonly key?: string;
    }
  | {
      readonly kind: "goal";
      readonly displayContent: string;
      readonly goalId: string;
      readonly round: number;
      readonly maxRounds: number;
    }
  | {
      readonly kind: "job";
      readonly displayContent: string;
      readonly jobId: string;
    }
  | {
      readonly kind: "subagent";
      readonly displayContent: string;
      readonly agentId: string;
    }
  | {
      readonly kind: "user_task";
      readonly displayContent: string;
      readonly taskId: string;
    };

export type AgentInboxItem = {
  readonly message: UserMessage;
  readonly delivery: AgentInputDelivery;
};

export type AgentInboxSnapshot = {
  readonly nextStep: readonly AgentInboxItem[];
  readonly nextTurn: readonly AgentInboxItem[];
};

export class AgentInbox {
  private readonly nextStepItems: AgentInboxItem[] = [];
  private readonly nextTurnItems: AgentInboxItem[] = [];
  private readonly pendingIds = new Set<MessageId>();

  constructor(snapshot?: AgentInboxSnapshot) {
    for (const item of snapshot?.nextStep ?? []) {
      this.enqueue(item, "next-step");
    }
    for (const item of snapshot?.nextTurn ?? []) {
      this.enqueue(item, "next-turn");
    }
  }

  get snapshot(): AgentInboxSnapshot {
    return {
      nextStep: [...this.nextStepItems],
      nextTurn: [...this.nextTurnItems],
    };
  }

  enqueue(item: AgentInboxItem, lane: AgentInputLane): void {
    if (this.pendingIds.has(item.message.id)) {
      throw new Error(`Message ${item.message.id} is already pending in the Agent inbox.`);
    }

    this.pendingIds.add(item.message.id);
    this.itemsFor(lane).push(item);
  }

  peekNextStep(): AgentInboxItem | undefined {
    return cloneItem(this.nextStepItems[0]);
  }

  shiftNextStep(): AgentInboxItem | undefined {
    return this.shift(this.nextStepItems);
  }

  claimNextStep(id: MessageId): AgentInboxItem {
    const item = this.nextStepItems[0];
    if (!item) {
      throw new Error(`Cannot claim Message ${id}; the next-step lane is empty.`);
    }
    if (item.message.id !== id) {
      throw new Error(
        `Cannot claim Message ${id}; the next-step head is Message ${item.message.id}.`,
      );
    }

    const claimed = this.shift(this.nextStepItems);
    if (!claimed) {
      throw new Error(`Cannot claim Message ${id}; the next-step lane changed unexpectedly.`);
    }
    return claimed;
  }

  shiftNextTurn(): AgentInboxItem | undefined {
    return this.shift(this.nextTurnItems);
  }

  deferNextStep(): AgentInboxItem[] {
    if (this.nextStepItems.length === 0) {
      return [];
    }

    // Moving an item changes only its delivery lane. The Message object and ID
    // remain the same, and deferred steering joins the existing next-turn tail.
    const deferred = this.nextStepItems.splice(0);
    this.nextTurnItems.push(...deferred);
    return deferred;
  }

  remove(id: MessageId): AgentInboxItem | undefined {
    for (const items of [this.nextStepItems, this.nextTurnItems]) {
      const index = items.findIndex((item) => item.message.id === id);
      if (index < 0) {
        continue;
      }

      const [removed] = items.splice(index, 1);
      this.pendingIds.delete(id);
      return cloneItem(removed);
    }
    return undefined;
  }

  clear(preserveIds: ReadonlySet<MessageId> = new Set()): AgentInboxItem[] {
    const removed: AgentInboxItem[] = [];
    for (const items of [this.nextStepItems, this.nextTurnItems]) {
      let retainedCount = 0;
      for (const item of items) {
        if (preserveIds.has(item.message.id)) {
          items[retainedCount] = item;
          retainedCount += 1;
          continue;
        }
        removed.push(item);
        this.pendingIds.delete(item.message.id);
      }
      items.length = retainedCount;
    }
    return removed;
  }

  private shift(items: AgentInboxItem[]): AgentInboxItem | undefined {
    const item = items.shift();
    if (!item) {
      return undefined;
    }
    this.pendingIds.delete(item.message.id);
    return item;
  }

  private itemsFor(lane: AgentInputLane): AgentInboxItem[] {
    return lane === "next-step" ? this.nextStepItems : this.nextTurnItems;
  }
}

function cloneItem(item: AgentInboxItem | undefined): AgentInboxItem | undefined {
  return item === undefined ? undefined : item;
}
