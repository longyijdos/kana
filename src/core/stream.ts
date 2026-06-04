import type { AssistantMessageEvent } from "./events";
import type { AssistantMessage } from "./messages";
import { EventStream, type ReadableEventStream } from "../utils/event-stream";

export type AssistantDoneEvent = Extract<
  AssistantMessageEvent,
  { type: "done" }
>;

export type AssistantErrorEvent = Extract<
  AssistantMessageEvent,
  { type: "error" }
>;

export type AssistantStreamEvent = Exclude<
  AssistantMessageEvent,
  AssistantDoneEvent | AssistantErrorEvent
>;

export type ReadableAssistantEventStream = ReadableEventStream<
  AssistantMessageEvent,
  AssistantMessage
>;

// Writable stream primitive for provider adapters. Consumers should depend on
// ReadableAssistantEventStream so push/end/error stay implementation details.
export class AssistantEventStream implements ReadableAssistantEventStream {
  private readonly stream = new EventStream<
    AssistantMessageEvent,
    AssistantMessage
  >("Cannot push to a closed assistant event stream.");

  push(event: AssistantStreamEvent): void {
    this.stream.push(event);
  }

  end(event: AssistantDoneEvent): void {
    this.stream.end(event, event.message);
  }

  error(event: AssistantErrorEvent): void {
    this.stream.push(event);
    this.stream.error(event.error);
  }

  result(): Promise<AssistantMessage> {
    return this.stream.result();
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return this.stream[Symbol.asyncIterator]();
  }
}
