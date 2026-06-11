import type { Message } from "@/core";
import { EventStream, type ReadableEventStream } from "@/utils";
import type { AgentEvent } from "./events";

export type AgentDoneEvent = Extract<AgentEvent, { type: "agent_end" }>;
export type AgentStreamEvent = Exclude<AgentEvent, AgentDoneEvent>;

export type ReadableAgentEventStream = ReadableEventStream<
  AgentEvent,
  Message[]
>;

export class AgentEventStream implements ReadableAgentEventStream {
  private readonly stream = new EventStream<AgentEvent, Message[]>(
    "Cannot push to a closed agent event stream.",
  );

  push(event: AgentStreamEvent): void {
    this.stream.push(event);
  }

  end(event: AgentDoneEvent): void {
    this.stream.end(event, event.messages);
  }

  error(error: unknown): void {
    this.stream.error(error);
  }

  result(): Promise<Message[]> {
    return this.stream.result();
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this.stream[Symbol.asyncIterator]();
  }
}
