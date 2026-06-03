import type { AssistantMessageEvent } from "./events";
import type { AssistantMessage } from "./messages";

export type AssistantMessageDoneEvent = Extract<
  AssistantMessageEvent,
  { type: "done" }
>;

export type AssistantMessageErrorEvent = Extract<
  AssistantMessageEvent,
  { type: "error" }
>;

export type AssistantMessageStreamEvent = Exclude<
  AssistantMessageEvent,
  AssistantMessageDoneEvent | AssistantMessageErrorEvent
>;

export type ReadableAssistantMessageStream =
  AsyncIterable<AssistantMessageEvent> & {
    result(): Promise<AssistantMessage>;
  };

// Writable stream primitive for provider adapters. Consumers should depend on
// ReadableAssistantMessageStream so push/end/error stay implementation details.
export class AssistantMessageStream
  implements ReadableAssistantMessageStream
{
  private queue: AssistantMessageEvent[] = [];
  private readers: Array<
    (result: IteratorResult<AssistantMessageEvent>) => void
  > = [];
  private closed = false;
  private readonly resultPromise: Promise<AssistantMessage>;
  private resolveResult!: (message: AssistantMessage) => void;
  private rejectResult!: (error: unknown) => void;

  constructor() {
    this.resultPromise = new Promise<AssistantMessage>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });

    // Avoid unhandled rejection noise when callers only consume events and do
    // not await result().
    this.resultPromise.catch(() => {});
  }

  push(event: AssistantMessageStreamEvent): void {
    this.enqueue(event);
  }

  end(event: AssistantMessageDoneEvent): void {
    this.enqueue(event);
    this.close();
    this.resolveResult(event.message);
  }

  error(event: AssistantMessageErrorEvent): void {
    this.enqueue(event);
    this.close();
    this.rejectResult(event.error);
  }

  result(): Promise<AssistantMessage> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<AssistantMessageEvent>> {
    const event = this.queue.shift();

    if (event) {
      return Promise.resolve({ done: false, value: event });
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve) => {
      this.readers.push(resolve);
    });
  }

  private enqueue(event: AssistantMessageEvent): void {
    if (this.closed) {
      throw new Error("Cannot push to a closed assistant message stream.");
    }

    const reader = this.readers.shift();

    if (reader) {
      reader({ done: false, value: event });
      return;
    }

    this.queue.push(event);
  }

  private close(): void {
    this.closed = true;

    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }
}
