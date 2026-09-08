import { afterEach, describe, expect, test } from "bun:test";
import { BackgroundJobManager } from "../../src/jobs";
import { createJobStartTool } from "../../src/tools/job-start";
import {
  createToolContext,
  createWorkspaceToolFixture,
  expectToolResult,
} from "./workspace-fixture";

const { cleanupTempRoots, createTempRoot } = createWorkspaceToolFixture();

describe("job_start tool", () => {
  afterEach(cleanupTempRoots);

  test("starts a session-owned background Job and streams its output separately", async () => {
    const root = await createTempRoot();
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const start = createJobStartTool(jobs, { root });
    const result = await start.execute(
      {
        command: "printf start; sleep 0.1; printf end",
      },
      createToolContext(),
    );
    expectToolResult(result);
    const jobId = result.result.jobId;

    expect(result.result).toMatchObject({
      status: "running",
    });
    expect(jobId).toStartWith("job_");
    const output = await readJobToCompletion(jobs, jobId);
    expect(output).toBe("startend");
    expect(jobs.list()[0]).toMatchObject({ status: "completed", exitCode: 0 });
    await manager.close();
  });

  test("rejects empty commands and canceled launches without creating jobs", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const start = createJobStartTool(jobs);
    try {
      await expect(start.execute({ command: " " }, createToolContext())).rejects.toThrow(
        "Command is required.",
      );
      const controller = new AbortController();
      controller.abort();
      await expect(
        start.execute(
          { command: "sleep 1" },
          { ...createToolContext(), signal: controller.signal },
        ),
      ).rejects.toThrow("Command aborted.");
      expect(jobs.list()).toEqual([]);
    } finally {
      await manager.close();
    }
  });

  test("applies an explicit timeout to the background process", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    try {
      const start = createJobStartTool(jobs);
      const result = await start.execute(
        { command: "sleep 10", timeoutMs: 30 },
        createToolContext(),
      );
      expectToolResult(result);
      await readJobToCompletion(jobs, result.result.jobId);
      expect(jobs.list()[0]).toMatchObject({ status: "failed", exitCode: null });
    } finally {
      await manager.close();
    }
  });
});

async function readJobToCompletion(
  jobs: import("../../src/jobs").BackgroundJobClient,
  jobId: string,
): Promise<string> {
  let output = "";
  for (;;) {
    const snapshot = await jobs.read(jobId, { waitMs: 1_000 });
    output += snapshot.chunks.map((chunk) => chunk.text).join("");
    if (snapshot.status !== "running" && snapshot.status !== "stopping") {
      return output;
    }
  }
}
