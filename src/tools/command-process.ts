import type { BackgroundJobOutputStream, BackgroundJobTerminalStatus } from "@/jobs";

const PROCESS_GROUP_POLL_MS = 25;
const TERMINATE_GRACE_MS = 500;
const KILL_GRACE_MS = 1_000;
const OUTPUT_DRAIN_MS = 100;

export type CommandProcessResult = {
  status: BackgroundJobTerminalStatus;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
};

export type RunCommandProcessOptions = {
  command: string;
  cwd: string;
  shell: string;
  prefix?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput(stream: BackgroundJobOutputStream, text: string): void;
};

export async function runCommandProcess(
  options: RunCommandProcessOptions,
): Promise<CommandProcessResult> {
  const proc = Bun.spawn([options.shell, "-lc", `${options.prefix ?? ""}${options.command}`], {
    cwd: options.cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let stopReason: "timeout" | "abort" | "failure" | undefined;
  let stopPromise: Promise<boolean> | undefined;
  const requestStop = (reason: "timeout" | "abort" | "failure"): void => {
    if (stopReason) {
      return;
    }
    stopReason = reason;
    stopPromise = terminateProcessGroup(proc);
  };
  const outputController = new AbortController();
  let outputFailure: { reason: unknown } | undefined;
  const outputPromises = [
    readCommandOutput(proc.stdout, "stdout", options.onOutput, outputController.signal),
    readCommandOutput(proc.stderr, "stderr", options.onOutput, outputController.signal),
  ].map((output) =>
    output.catch((error) => {
      outputFailure ??= { reason: error };
      requestStop("failure");
    }),
  );
  const onAbort = (): void => requestStop("abort");
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => requestStop("timeout"), options.timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    onAbort();
  }

  let exitCode: number | null = null;
  let exitKnown = true;
  try {
    exitCode = await proc.exited;
  } catch {
    exitKnown = false;
    requestStop("failure");
  }

  while (!stopPromise && isProcessGroupRunning(proc.pid)) {
    await delay(PROCESS_GROUP_POLL_MS);
  }
  const quiescent = stopPromise ? await stopPromise : true;
  if (timeout) {
    clearTimeout(timeout);
  }
  options.signal?.removeEventListener("abort", onAbort);

  await Promise.race([Promise.allSettled(outputPromises), delay(OUTPUT_DRAIN_MS)]);
  outputController.abort();
  await Promise.all(outputPromises);
  if (outputFailure) {
    throw outputFailure.reason;
  }

  if (!exitKnown || !quiescent) {
    return {
      status: "unknown",
      exitCode,
      timedOut: stopReason === "timeout",
      aborted: stopReason === "abort",
    };
  }
  if (stopReason === "abort") {
    return { status: "canceled", exitCode, timedOut: false, aborted: true };
  }
  if (stopReason === "timeout") {
    return { status: "failed", exitCode: null, timedOut: true, aborted: false };
  }
  return {
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    timedOut: false,
    aborted: false,
  };
}

async function readCommandOutput(
  stream: ReadableStream<Uint8Array>,
  name: BackgroundJobOutputStream,
  onOutput: (stream: BackgroundJobOutputStream, text: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text) {
        onOutput(name, text);
      }
    }
    const remaining = decoder.decode();
    if (remaining) {
      onOutput(name, remaining);
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function terminateProcessGroup(proc: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  signalProcessGroup(proc, "SIGTERM");
  if (await waitForProcessGroupExit(proc.pid, TERMINATE_GRACE_MS)) {
    return true;
  }
  signalProcessGroup(proc, "SIGKILL");
  return waitForProcessGroupExit(proc.pid, KILL_GRACE_MS);
}

function signalProcessGroup(proc: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // The process group may have exited between the liveness check and signal.
    }
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupRunning(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(PROCESS_GROUP_POLL_MS);
  }
  return true;
}

function isProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
