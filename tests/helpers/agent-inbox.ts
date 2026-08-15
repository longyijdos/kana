import {
  AgentInbox,
  type AgentInboxItem,
  type AgentInboxSnapshot,
  type AgentInputDelivery,
  type AgentInputLane,
} from "@/agent";
import type { MessageId, UserMessage } from "@/core";

type AgentInboxStub = {
  readonly inbox: AgentInbox["snapshot"];
  subscribeInbox(listener: (snapshot: AgentInboxSnapshot) => void): () => void;
  enqueueInput(input: UserMessage, lane: AgentInputLane, delivery: AgentInputDelivery): void;
  shiftNextTurnInput(): AgentInboxItem | undefined;
  cancelInput(id: MessageId): AgentInboxItem | undefined;
  clearInbox(): void;
};

export function withAgentInboxForTest<T extends object>(agent: T): T & AgentInboxStub {
  const inbox = new AgentInbox();
  const listeners = new Set<(snapshot: AgentInboxSnapshot) => void>();
  const notify = (): void => {
    const snapshot = inbox.snapshot;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  Object.defineProperty(agent, "inbox", {
    configurable: true,
    enumerable: true,
    get: () => inbox.snapshot,
  });
  return Object.assign(agent, {
    subscribeInbox(listener: (snapshot: AgentInboxSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueueInput(input: UserMessage, lane: AgentInputLane, delivery: AgentInputDelivery) {
      inbox.enqueue({ message: input, delivery }, lane);
      notify();
    },
    shiftNextTurnInput() {
      const item = inbox.shiftNextTurn();
      if (item) {
        notify();
      }
      return item;
    },
    cancelInput(id: MessageId) {
      const item = inbox.remove(id);
      if (item) {
        notify();
      }
      return item;
    },
    clearInbox() {
      if (inbox.clear().length > 0) {
        notify();
      }
    },
  }) as T & AgentInboxStub;
}
