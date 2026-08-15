import type { MessageId, UserMessage } from "@/core";

export type AgentInputLane = "next-step" | "next-turn";

export type AgentInputDelivery =
  | { kind: "steering" }
  | { kind: "queued" }
  | {
      kind: "scheduled";
      displayContent: string;
      dueAt: Date;
      key?: string;
    };

export type AgentInboxItem = {
  message: UserMessage;
  delivery: AgentInputDelivery;
};

export type AgentInboxSnapshot = {
  nextStep: AgentInboxItem[];
  nextTurn: AgentInboxItem[];
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
      nextStep: structuredClone(this.nextStepItems),
      nextTurn: structuredClone(this.nextTurnItems),
    };
  }

  enqueue(item: AgentInboxItem, lane: AgentInputLane): void {
    if (this.pendingIds.has(item.message.id)) {
      throw new Error(`Message ${item.message.id} is already pending in the Agent inbox.`);
    }

    this.pendingIds.add(item.message.id);
    this.itemsFor(lane).push(structuredClone(item));
  }

  peekNextStep(): AgentInboxItem | undefined {
    return cloneItem(this.nextStepItems[0]);
  }

  shiftNextStep(): AgentInboxItem | undefined {
    return this.shift(this.nextStepItems);
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
    return structuredClone(deferred);
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

  clear(): AgentInboxItem[] {
    const removed = [...this.nextStepItems, ...this.nextTurnItems];
    this.nextStepItems.length = 0;
    this.nextTurnItems.length = 0;
    this.pendingIds.clear();
    return structuredClone(removed);
  }

  private shift(items: AgentInboxItem[]): AgentInboxItem | undefined {
    const item = items.shift();
    if (!item) {
      return undefined;
    }
    this.pendingIds.delete(item.message.id);
    return structuredClone(item);
  }

  private itemsFor(lane: AgentInputLane): AgentInboxItem[] {
    return lane === "next-step" ? this.nextStepItems : this.nextTurnItems;
  }
}

function cloneItem(item: AgentInboxItem | undefined): AgentInboxItem | undefined {
  return item === undefined ? undefined : structuredClone(item);
}
