import { describe, expect, test } from "bun:test";
import { BackgroundJobManager } from "@/jobs";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BackgroundJobManagerController } from "../../src/tui/app/background-job-manager-controller";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("background Job manager controller", () => {
  test("opens with terminal Jobs without acknowledging their completion", async () => {
    const jobManager = new BackgroundJobManager();
    const jobs = jobManager.bind(jobManager.createOwner("session-a"), { maxConcurrent: 1 });
    const job = jobs.start({
      kind: "bash",
      label: "completed build",
      run: async () => ({ status: "completed", exitCode: 0 }),
    });
    await waitFor(() => jobs.list()[0]?.status === "completed");

    const editor = new Editor({ model: "test-model" });
    const layout = new AppLayout({ main: new Transcript(), bottom: editor });
    const tui = createTuiStub();
    const controller = new BackgroundJobManagerController({
      editor,
      bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
      tui,
      getJobs: () => jobs,
      showError: () => {},
      onClose: () => {},
    });

    controller.open();

    const rendered = stripAnsi(tui.getFocus()?.render(100).join("\n") ?? "");
    expect(rendered).toContain("completed");
    expect(rendered).toContain("output tail (non-consuming)");
    expect(jobs.context()).toMatchObject([{ id: job.id, status: "completed" }]);

    controller.close();
    await jobManager.close();
  });

  test("refreshes a terminal completion without consuming it while open", async () => {
    const jobManager = new BackgroundJobManager();
    const jobs = jobManager.bind(jobManager.createOwner("session-a"), { maxConcurrent: 1 });
    const completion = deferred<{ status: "completed"; exitCode: number }>();
    const job = jobs.start({
      kind: "bash",
      label: "delayed build",
      run: () => completion.promise,
    });
    const editor = new Editor({ model: "test-model" });
    const layout = new AppLayout({ main: new Transcript(), bottom: editor });
    const tui = createTuiStub();
    const controller = new BackgroundJobManagerController({
      editor,
      bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
      tui,
      getJobs: () => jobs,
      showError: () => {},
      onClose: () => {},
    });

    controller.open();
    expect(stripAnsi(tui.getFocus()?.render(100).join("\n") ?? "")).toContain("running");

    completion.resolve({ status: "completed", exitCode: 0 });
    await waitFor(() =>
      stripAnsi(tui.getFocus()?.render(100).join("\n") ?? "").includes("completed"),
    );

    expect(jobs.context()).toMatchObject([{ id: job.id, status: "completed" }]);
    controller.close();
    await jobManager.close();
  });

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
      bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
      tui,
      getJobs: () => jobs,
      showError: (error) => errors.push(error),
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
    expect(jobs.context()).toMatchObject([{ id: job.id, status: "canceled" }]);
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
