export type ReadableEventStream<TEvent, TResult> = AsyncIterable<TEvent> & {
  result(): Promise<TResult>;
};

export class EventStream<TEvent, TResult> implements ReadableEventStream<TEvent, TResult> {
  private queue: TEvent[] = [];
  private readers: Array<(result: IteratorResult<TEvent>) => void> = [];
  private closed = false;
  private readonly resultPromise: Promise<TResult>;
  private resolveResult!: (result: TResult) => void;
  private rejectResult!: (error: unknown) => void;

  constructor(private readonly closedErrorMessage: string) {
    this.resultPromise = new Promise<TResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });

    // Avoid unhandled rejection noise when callers only consume events and do
    // not await result().
    this.resultPromise.catch(() => {});
  }

  push(event: TEvent): void {
    this.enqueue(event);
  }

  end(event: TEvent, result: TResult): void {
    this.enqueue(event);
    this.close();
    this.resolveResult(result);
  }

  error(error: unknown): void {
    this.close();
    this.rejectResult(error);
  }

  result(): Promise<TResult> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<TEvent>> {
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

  private enqueue(event: TEvent): void {
    if (this.closed) {
      throw new Error(this.closedErrorMessage);
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
