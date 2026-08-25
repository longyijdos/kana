import { describe, expect, test } from "bun:test";
import { BackgroundJobManager } from "@/jobs";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BackgroundJobManagerController } from "../../src/tui/app/background-job-manager-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("background Job manager controller", () => {
  test("peeks without consuming output, stops active work, and restores the editor", async () => {
    const jobManager = new BackgroundJobManager();
    const jobs = jobManager.bind(jobManager.createOwner("session-a"), { maxConcurrent: 1 });
    const job = jobs.start({
      kind: "bash",
      label: "bun run dev",
      run: ({ signal, write }) => {
        write("stdout", "server ready\n");
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "canceled", exitCode: null }), {
            once: true,
          });
        });
      },
    });
    const editor = new Editor({ model: "test-model" });
    const layout = new AppLayout({ main: new Transcript(), bottom: editor });
    const tui = createTuiStub();
    const errors: unknown[] = [];
    let closes = 0;
    const controller = new BackgroundJobManagerController({
      editor,
      layout,
      tui,
      getJobs: () => jobs,
      showError: (error) => errors.push(error),
      restoreBottom: (focus) => {
        layout.showBottom(editor);
        if (focus) {
          tui.setFocus(editor);
        }
      },
      onClose: () => {
        closes += 1;
      },
    });

    controller.open();
    expect(stripAnsi(tui.getFocus()?.render(100).join("\n") ?? "")).toContain("server ready");
    expect((await jobs.read(job.id)).chunks).toEqual([
      { stream: "stdout", text: "server ready\n" },
    ]);

    tui.getFocus()?.handleInput?.("K");
    await waitFor(() => jobs.list()[0]?.status === "canceled");
    expect(stripAnsi(tui.getFocus()?.render(100).join("\n") ?? "")).toContain("canceled");
    expect(errors).toEqual([]);

    tui.getFocus()?.handleInput?.("\x1b");
    expect(controller.active).toBe(false);
    expect(closes).toBe(1);
    expect(tui.getFocus()).toBe(editor);
    await jobManager.close();
  });
});

function createTuiStub(): Tui {
  let focus: Component | undefined;
  return {
    requestRender: () => {},
    getFocus: () => focus,
    setFocus: (component: Component | undefined) => {
      focus = component;
    },
  } as unknown as Tui;
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
