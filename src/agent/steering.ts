import type { MessageId, UserMessage } from "@/core";
import type { Logger } from "@/logging";
import {
  AgentInbox,
  type AgentInboxItem,
  type AgentInboxSnapshot,
  type AgentInputDelivery,
  type AgentInputLane,
} from "./inbox";

export type AgentSteerOutcome = "consumed" | "deferred";

export type AgentInboxListener = (snapshot: AgentInboxSnapshot) => void;

// Owns queued input between and during runs. Steering callers learn whether
// their input reached the current run or was deferred to the next one.
export class SteeringQueue {
  private readonly inbox: AgentInbox;
  private readonly listeners = new Set<AgentInboxListener>();
  private readonly resolvers = new Map<MessageId, (outcome: AgentSteerOutcome) => void>();
  // Items crossing the journal boundary can no longer be cancelled or cleared.
  private readonly committing = new Set<MessageId>();

  constructor(
    snapshot: AgentInboxSnapshot | undefined,
    private readonly logger: Logger,
  ) {
    this.inbox = new AgentInbox(snapshot);
  }

  get snapshot(): AgentInboxSnapshot {
    return this.inbox.snapshot;
  }

  subscribe(listener: AgentInboxListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  enqueue(input: UserMessage, lane: AgentInputLane, delivery: AgentInputDelivery): void {
    this.inbox.enqueue({ message: input, delivery }, lane);
    this.changed();
  }

  steer(input: UserMessage): Promise<AgentSteerOutcome> {
    return new Promise((resolve) => {
      this.enqueue(input, "next-step", { kind: "steering" });
      // Register the waiter only after insertion succeeds, so a duplicate ID
      // cannot replace the original caller's resolver.
      this.resolvers.set(input.id, resolve);
      this.logger.info("agent.steering_input_queued", {
        pendingInputCount: this.inbox.snapshot.nextStep.length,
      });
    });
  }

  shiftNextTurn(): AgentInboxItem | undefined {
    const item = this.inbox.shiftNextTurn();
    if (item) {
      this.changed();
    }
    return item;
  }

  cancel(id: MessageId): AgentInboxItem | undefined {
    if (this.committing.has(id)) {
      this.logger.info("agent.input_cancel_skipped", { reason: "commit_in_progress" });
      return undefined;
    }
    const item = this.inbox.remove(id);
    if (item) {
      this.settle(id, "deferred");
      this.changed();
    }
    return item;
  }

  clear(): void {
    const removed = this.inbox.clear(this.committing);
    for (const item of removed) {
      this.settle(item.message.id, "deferred");
    }
    if (removed.length > 0) {
      this.changed();
    }
  }

  // Commits each next-step item before removing it from the queue, so a
  // journal failure leaves the item queued rather than lost.
  async consume(commit: (message: UserMessage) => Promise<void>): Promise<UserMessage[]> {
    const consumed: UserMessage[] = [];
    for (let pending = this.inbox.peekNextStep(); pending; pending = this.inbox.peekNextStep()) {
      const id = pending.message.id;
      this.committing.add(id);
      try {
        await commit(pending.message);
        consumed.push(this.inbox.claimNextStep(id).message);
      } finally {
        this.committing.delete(id);
      }
      this.settle(id, "consumed");
    }
    if (consumed.length > 0) {
      this.changed();
      this.logger.info("agent.steering_inputs_consumed", { inputCount: consumed.length });
    }
    return consumed;
  }

  // Steering left over when a run ends waits for the next run.
  deferPending(): void {
    const deferred = this.inbox.deferNextStep();
    if (deferred.length === 0) {
      return;
    }
    this.logger.info("agent.steering_inputs_deferred", { inputCount: deferred.length });
    for (const item of deferred) {
      this.settle(item.message.id, "deferred");
    }
    this.changed();
  }

  private settle(id: MessageId, outcome: AgentSteerOutcome): void {
    this.resolvers.get(id)?.(outcome);
    this.resolvers.delete(id);
  }

  private changed(): void {
    const snapshot = this.inbox.snapshot;
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.warn("agent.inbox_listener_failed", { error });
      }
    }
  }
}
