import { describe, expect, test } from "bun:test";
import { BackgroundJobManager, type BackgroundJobTerminalStatus } from "@/jobs";
import { createJobKillTool, createJobListTool, createJobOutputTool } from "@/tools";
import type { ToolResult } from "../../src/tools/tool";

type ProducerResult = {
  status: BackgroundJobTerminalStatus;
  exitCode: number | null;
};

describe("Background Job tools", () => {
  test("lists Jobs and reads bounded unseen output", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const completion = deferred<ProducerResult>();
    const job = jobs.start({
      kind: "test",
      label: "stream",
      run: ({ write }) => {
        write("stdout", "alpha\n");
        write("stderr", "beta\n");
        return completion.promise;
      },
    });
    const listTool = createJobListTool(jobs);
    const outputTool = createJobOutputTool(jobs);

    const listed = await listTool.execute({}, createToolContext());
    expectToolResult(listed);
    expect(listed.result).toMatchObject([{ id: job.id, status: "running" }]);
    const first = await outputTool.execute({ jobId: job.id }, createToolContext());
    expectToolResult(first);
    expect(first.content).toContain("status: running");
    expect(first.content).toContain("stdout:\nalpha\n");
    expect(first.content).toContain("stderr:\nbeta\n");
    expect(first.result).toMatchObject({ hasMore: false, waitTimedOut: false });
    const second = await outputTool.execute({ jobId: job.id }, createToolContext());
    expectToolResult(second);
    expect(second.content).toContain("(no new output)");

    completion.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() => jobs.list()[0]?.status === "completed");
    expect(jobs.context()).toHaveLength(1);
    await listTool.execute({}, createToolContext());
    expect(jobs.context()).toEqual([]);
    await manager.close();
  });

  test("kills active Jobs and reports unknown IDs as tool errors", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const job = jobs.start({
      kind: "test",
      label: "until canceled",
      run: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "canceled", exitCode: null }), {
            once: true,
          });
        }),
    });
    const killTool = createJobKillTool(jobs);
    const outputTool = createJobOutputTool(jobs);

    const killed = await killTool.execute(
      { jobId: job.id, reason: "No longer needed." },
      createToolContext(),
    );
    expectToolResult(killed);
    expect(killed.result).toMatchObject({ id: job.id, status: "canceled" });
    expect(killed.isError).toBe(false);
    expect(jobs.context()).toEqual([]);

    const unknown = await outputTool.execute(
      { jobId: "job_missing", waitMs: 0 },
      createToolContext(),
    );
    expectToolResult(unknown);
    expect(unknown.result).toMatchObject({ jobId: "job_missing", status: "unknown" });
    expect(unknown.isError).toBe(true);
    await manager.close();
  });
});

function createToolContext() {
  return {
    toolCallId: "call-1",
    update: () => {},
    signal: new AbortController().signal,
  };
}

function expectToolResult<T>(value: unknown): asserts value is ToolResult<T> {
  expect(value).toBeObject();
  expect(value).toHaveProperty("content");
  expect(value).toHaveProperty("result");
}

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
