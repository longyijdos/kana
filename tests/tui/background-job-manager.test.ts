import { describe, expect, test } from "bun:test";
import type { BackgroundJobSummary } from "@/jobs";
import { BackgroundJobManager, type BackgroundJobManagerAction } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";

describe("background Job manager", () => {
  test("renders a sanitized non-consuming output tail and routes active Job actions", () => {
    const actions: BackgroundJobManagerAction[] = [];
    const manager = new BackgroundJobManager((action) => actions.push(action));
    const completed = job("job_completed", "completed", "old build");
    const running = job("job_running1", "running", "bun run\n\u001b[31mdev\u001b[0m");
    manager.replaceJobs([completed, running]);
    manager.replacePreview({
      jobId: completed.id,
      status: "completed",
      chunks: [{ stream: "stdout", text: "line one\nline \u001b[31mtwo\u001b[0m\n" }],
      truncated: false,
      droppedBytes: 0,
      exitCode: 0,
    });

    const rendered = stripAnsi(manager.render(100).join("\n"));
    expect(rendered).toContain("complete · completed · old build");
    expect(rendered).toContain("running1 · running · bun run dev");
    expect(rendered).toContain("output tail (non-consuming)");
    expect(rendered).toContain("line two");
    expect(rendered).not.toContain("\u001b[31m");

    manager.handleInput("K");
    manager.handleInput("\x1b[B");
    manager.handleInput("K");
    manager.handleInput("R");
    manager.handleInput("\x1b");

    expect(actions).toEqual([
      { type: "select", job: running },
      { type: "kill", job: running },
      { type: "refresh" },
      { type: "close" },
    ]);
  });

  test("pages the selection by one window and reports each landed Job once", () => {
    const actions: BackgroundJobManagerAction[] = [];
    const manager = new BackgroundJobManager((action) => actions.push(action));
    const jobs = Array.from({ length: 8 }, (_, index) =>
      job(`job_page${index}`, "completed", `build ${index}`),
    );
    manager.replaceJobs(jobs);

    manager.handleInput("\x1b[6~");
    expect(manager.selectedJob?.id).toBe("job_page3");

    manager.handleInput("\x1b[6~");
    expect(manager.selectedJob?.id).toBe("job_page7");

    manager.handleInput("\x1b[6~");
    expect(manager.selectedJob?.id).toBe("job_page7");

    manager.handleInput("\x1b[1~");
    expect(manager.selectedJob?.id).toBe("job_page0");

    expect(actions).toEqual([
      { type: "select", job: jobs[3] },
      { type: "select", job: jobs[7] },
      { type: "select", job: jobs[0] },
    ]);
  });
});

function job(
  id: string,
  status: BackgroundJobSummary["status"],
  label: string,
): BackgroundJobSummary {
  return {
    id,
    kind: "bash",
    label,
    cwd: ".",
    status,
    startedAt: new Date("2026-08-25T08:00:00.000Z"),
    ...(status === "running" ? {} : { finishedAt: new Date("2026-08-25T08:01:00.000Z") }),
    exitCode: status === "completed" ? 0 : null,
  };
}
