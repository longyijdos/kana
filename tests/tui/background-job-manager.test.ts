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
