import { describe, expect, test } from "bun:test";
import { BackgroundJobManager, type BackgroundJobTerminalStatus } from "@/jobs";

type ProducerResult = {
  status: BackgroundJobTerminalStatus;
  exitCode: number | null;
};

describe("BackgroundJobManager", () => {
  test("isolates owners and enforces concurrency per session instance", async () => {
    const manager = new BackgroundJobManager();
    const first = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const second = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const completion = deferred<ProducerResult>();
    const job = first.start({ kind: "test", label: "first", run: () => completion.promise });

    expect(() =>
      first.start({
        kind: "test",
        label: "over limit",
        run: async () => ({ status: "completed", exitCode: 0 }),
      }),
    ).toThrow("Background Job limit reached (1/1).");
    expect(second.list()).toEqual([]);
    expect(second.peek(job.id).status).toBe("unknown");
    expect((await second.kill(job.id, { source: "tool" })).status).toBe("unknown");

    completion.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => first.list()[0]?.status === "completed");
    await manager.close();
  });

  test("normalizes and bounds labels stored in Job metadata", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const job = jobs.start({
      kind: "test",
      label: `  long\ncommand  ${"界".repeat(300)}  `,
      run: async () => ({ status: "completed", exitCode: 0 }),
    });

    expect(job.label.startsWith("long command ")).toBe(true);
    expect(job.label.endsWith("…")).toBe(true);
    expect(job.label).not.toContain("\n");
    expect(Buffer.byteLength(job.label)).toBeLessThanOrEqual(512);
    await manager.close();
  });

  test("keeps a bounded UTF-8 output ring with an incremental consumer cursor", async () => {
    const manager = new BackgroundJobManager({
      maxRetainedOutputBytes: 8,
      maxOutputReadBytes: 4,
    });
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const completion = deferred<ProducerResult>();
    const job = jobs.start({
      kind: "test",
      label: "stream output",
      run: ({ write }) => {
        write("stdout", "abcdefghij");
        return completion.promise;
      },
    });

    expect(jobs.peek(job.id)).toMatchObject({
      status: "running",
      chunks: [{ stream: "stdout", text: "ij" }],
      truncated: true,
      droppedBytes: 4,
    });
    expect(await jobs.read(job.id)).toMatchObject({
      chunks: [{ stream: "stdout", text: "efgh" }],
      hasMore: true,
      droppedBytes: 4,
    });
    expect(await jobs.read(job.id)).toMatchObject({
      chunks: [{ stream: "stdout", text: "ij" }],
      hasMore: false,
      droppedBytes: 0,
    });
    expect((await jobs.read(job.id)).chunks).toEqual([]);

    completion.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => jobs.list()[0]?.status === "completed");
    await jobs.read(job.id);
    expect(jobs.context()).toEqual([]);
    await manager.close();
  });

  test("waits for new output without treating a timeout as Job completion", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const completion = deferred<ProducerResult>();
    let writeOutput: ((text: string) => void) | undefined;
    const job = jobs.start({
      kind: "test",
      label: "delayed output",
      run: ({ write }) => {
        writeOutput = (text) => write("stderr", text);
        return completion.promise;
      },
    });

    const waiting = jobs.read(job.id, { waitMs: 1_000 });
    writeOutput?.("ready");
    expect(await waiting).toMatchObject({
      status: "running",
      chunks: [{ stream: "stderr", text: "ready" }],
      waitTimedOut: false,
    });
    expect(await jobs.read(job.id, { waitMs: 1 })).toMatchObject({
      status: "running",
      chunks: [],
      waitTimedOut: true,
    });

    completion.resolve({ status: "completed", exitCode: 0 });
    await jobs.close();
  });

  test("Agent tool kill observes the canceled completion", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const job = jobs.start({
      kind: "test",
      label: "tool cancellation",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "canceled", exitCode: null }), {
            once: true,
          });
        }),
    });

    const result = await jobs.kill(job.id, { source: "tool" });

    expect(result).toMatchObject({ id: job.id, status: "canceled" });
    expect(jobs.context()).toEqual([]);
    await manager.close();
  });

  test("uses kill source to decide whether a terminal completion is observed", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const job = jobs.start({
      kind: "test",
      label: "terminal source",
      run: async () => ({ status: "completed", exitCode: 0 }),
    });
    await waitFor(() => jobs.list()[0]?.status === "completed");

    const tuiResult = await jobs.kill(job.id, { source: "tui" });
    expect(tuiResult).toMatchObject({ id: job.id, status: "completed" });
    expect(jobs.context()).toHaveLength(1);

    const toolResult = await jobs.kill(job.id, { source: "tool" });
    expect(toolResult).toMatchObject({ id: job.id, status: "completed" });
    expect(jobs.context()).toEqual([]);
    await manager.close();
  });

  test("publishes completion and observation once, then cancels active work on close", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 2 });
    const events: string[] = [];
    jobs.subscribe((event) => events.push(`${event.type}:${event.job.status}`));
    const completion = deferred<ProducerResult>();
    const completed = jobs.start({
      kind: "test",
      label: "complete",
      run: () => completion.promise,
    });
    const active = jobs.start({
      kind: "test",
      label: "active",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "canceled", exitCode: null }), {
            once: true,
          });
        }),
    });

    completion.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => events.includes("completed:completed"));
    jobs.observe(completed.id);
    jobs.observe(completed.id);
    expect(events).toEqual(["completed:completed", "observed:completed"]);

    await jobs.close();
    expect(jobs.list()).toEqual([]);
    expect(() =>
      jobs.start({
        kind: "test",
        label: "too late",
        run: async () => ({ status: "completed", exitCode: 0 }),
      }),
    ).toThrow("Background Jobs are unavailable while the session is closing.");
    expect(active.status).toBe("running");
    await manager.close();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met.");
}
