import type { AgentEvent } from "../events";
import type { AgentEventSink } from "./types";

// Delivers tool events in order without blocking the tool that produced them.
// The first delivery failure surfaces at the next drain.
export class SerialEventQueue {
  private tail: Promise<void> = Promise.resolve();
  private firstError: unknown;

  constructor(private readonly emitEvent: AgentEventSink) {}

  push(event: AgentEvent): void {
    this.tail = this.tail.then(async () => {
      try {
        await this.emitEvent(event);
      } catch (error) {
        this.firstError ??= error;
      }
    });
  }

  async emit(event: AgentEvent): Promise<void> {
    this.push(event);
    await this.drain();
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.firstError === undefined) {
      return;
    }
    const error = this.firstError;
    this.firstError = undefined;
    throw error;
  }
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
