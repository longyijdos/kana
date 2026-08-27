import type { ConversationRuntime } from "@/kana";
import type { Logger } from "@/logging";

export type HeadlessRunTermination =
  | {
      reason: "timeout";
      timeoutMs: number;
    }
  | {
      reason: "sigint";
    };

const HEADLESS_SIGNAL_REASON = Symbol("headlessSignalReason");

type HeadlessSignalReason = {
  [HEADLESS_SIGNAL_REASON]: HeadlessRunTermination;
};

type HeadlessRunLifecycleOptions = {
  runtime: ConversationRuntime;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
};

export class HeadlessRunLifecycle {
  private abortRequested = false;
  private listening = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private runTermination?: HeadlessRunTermination;

  constructor(private readonly options: HeadlessRunLifecycleOptions) {}

  get termination(): HeadlessRunTermination | undefined {
    return this.runTermination;
  }

  connect(): void {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  startDeadline(): void {
    const timeoutMs = this.options.timeoutMs;
    if (timeoutMs === undefined) {
      return;
    }
    this.timeout = setTimeout(() => {
      if (!this.requestAbort({ reason: "timeout", timeoutMs })) {
        return;
      }
      try {
        this.options.logger?.warn("headless.timeout_elapsed", {
          phase: "run",
          timeoutMs,
        });
      } catch {
        // Diagnostics must not change cancellation or cleanup behavior.
      }
    }, timeoutMs);
  }

  abortIfSignaled(): void {
    if (this.options.signal?.aborted) {
      this.onAbort();
    }
  }

  dispose(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    if (this.listening) {
      this.options.signal?.removeEventListener("abort", this.onAbort);
      this.listening = false;
    }
  }

  private readonly onAbort = (): void => {
    this.requestAbort(readHeadlessSignalReason(this.options.signal));
  };

  private requestAbort(termination?: HeadlessRunTermination): boolean {
    // Preserve the first cancellation source so output and exit status agree.
    if (this.abortRequested) {
      return false;
    }
    this.abortRequested = true;
    this.runTermination = termination;
    this.options.runtime.abort();
    return true;
  }
}

export function createHeadlessSignalReason(
  termination: HeadlessRunTermination,
): HeadlessSignalReason {
  // The hidden brand keeps arbitrary caller aborts distinct from process SIGINT.
  return { [HEADLESS_SIGNAL_REASON]: termination };
}

export function readHeadlessSignalReason(
  signal: AbortSignal | undefined,
): HeadlessRunTermination | undefined {
  if (!signal?.aborted || typeof signal.reason !== "object" || signal.reason === null) {
    return undefined;
  }
  const reason = signal.reason as Partial<HeadlessSignalReason>;
  return reason[HEADLESS_SIGNAL_REASON];
}
