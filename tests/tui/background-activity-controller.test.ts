import { describe, expect, test } from "bun:test";
import {
  type BackgroundJobClient,
  BackgroundJobManager,
  type BackgroundJobSummary,
  type BackgroundJobTerminalStatus,
} from "@/jobs";
import { type KanaSubagentClient, type KanaSubagentSummary, KanaUserTaskManager } from "@/kana";
import { BackgroundActivityController } from "../../src/tui/app/background-activity-controller";
import { Editor } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";
import { deferred, waitFor } from "../helpers/async-control";
import {
  type BackgroundClientStub,
  createBackgroundClient,
  jobSummary,
  subagentSummary,
} from "../helpers/background-activity";

describe("background activity controller", () => {
  test("lists running session work below the editor and ignores terminal records", () => {
    const harness = createHarness();
    harness.subagents.items.push(
      subagentSummary("agent_3f2a1b7c9d", "running", "reviewer: Check the parser"),
      subagentSummary("agent_dd0e5511aa", "completed", "worker: Finished the task"),
    );
    harness.jobs.items.push(
      jobSummary("job_82ac19de00", "running", "bun test"),
      jobSummary("job_5511dd0e77", "failed", "bun lint"),
    );

    harness.controller.bind();

    const rendered = harness.renderEditor();
    expect(rendered).toContain("Background · 2");
    expect(rendered).toContain("  subagent · 3f2a1b7c · running · reviewer: Check the parser");
    expect(rendered).toContain("  job      · 82ac19de · running · bun test");
    expect(rendered).not.toContain("worker: Finished the task");
    expect(rendered).not.toContain("bun lint");
  });

  test("tracks client events and clears the strip when the work settles", () => {
    const harness = createHarness();
    harness.controller.bind();
    expect(harness.renderEditor()).not.toContain("Background · ");

    harness.subagents.items.push(
      subagentSummary("agent_3f2a1b7c9d", "running", "explorer: Look around"),
    );
    harness.subagents.emit();
    expect(harness.renderEditor()).toContain("explorer: Look around");

    harness.jobs.items.push(jobSummary("job_82ac19de00", "stopping", "bun test"));
    harness.jobs.emit();
    expect(harness.renderEditor()).toContain("stopping · bun test");

    harness.subagents.items.length = 0;
    harness.jobs.items.length = 0;
    harness.subagents.emit();
    harness.jobs.emit();
    expect(harness.renderEditor()).not.toContain("Background · ");
  });

  test("shows accepted user tasks until they are completed or returned", () => {
    const harness = createHarness();
    harness.controller.bind();

    const first = harness.userTasks.create("Review the screenshot");
    const second = harness.userTasks.create("Check the wording");
    const rendered = harness.renderEditor();
    expect(rendered).toContain("Your tasks · 2 · /task");
    expect(rendered).toContain(`  ${first.id.slice(5, 13)} · Review the screenshot`);
    expect(rendered).toContain(`  ${second.id.slice(5, 13)} · Check the wording`);

    harness.userTasks.done(first.id, "The labels look good.");
    expect(harness.renderEditor()).not.toContain("Review the screenshot");
    expect(harness.renderEditor()).toContain("Check the wording");

    harness.userTasks.returnToAgent(second.id);
    expect(harness.renderEditor()).not.toContain("Your tasks · ");
  });

  test("follows a real Background Job through running, stopping, and settlement", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const editor = new Editor({ model: "test-model" });
    const controller = new BackgroundActivityController({
      editor,
      tui: createTuiStub(),
      getJobs: () => jobs,
      getSubagents: () => undefined,
      getUserTasks: () => undefined,
    });
    const rendered = () => stripAnsi(editor.render(96).join("\n"));
    controller.bind();
    expect(rendered()).not.toContain("Background · ");

    const completion = deferred<{ status: BackgroundJobTerminalStatus; exitCode: number | null }>();
    const job = jobs.start({
      kind: "bash",
      label: "bun test tests/tui",
      run: () => completion.promise,
    });
    const row = (status: string) =>
      `  job      · ${job.id.slice(4, 12)} · ${status} · bun test tests/tui`;

    expect(rendered()).toContain(row("running"));

    const cancellation = jobs.kill(job.id, { source: "tui" });
    expect(rendered()).toContain(row("stopping"));

    completion.resolve({ status: "canceled", exitCode: null });
    await cancellation;
    await waitFor(() => !rendered().includes("Background · "));

    controller.unbind();
    await manager.close();
  });

  test("drops its projection when the binding is released", () => {
    const harness = createHarness();
    harness.jobs.items.push(jobSummary("job_82ac19de00", "running", "bun test"));
    harness.controller.bind();
    expect(harness.renderEditor()).toContain("bun test");

    harness.controller.unbind();

    expect(harness.renderEditor()).not.toContain("Background · ");
  });

  test("rebinds the strip to the next session's clients", () => {
    const harness = createHarness();
    harness.userTasks.create("First session task");
    harness.subagents.items.push(
      subagentSummary("agent_3f2a1b7c9d", "running", "explorer: First session"),
    );
    harness.controller.bind();
    expect(harness.renderEditor()).toContain("First session");

    const nextSubagents = createBackgroundClient<KanaSubagentSummary>();
    nextSubagents.items.push(
      subagentSummary("agent_dd0e5511aa", "running", "worker: Second session"),
    );
    const nextJobs = createBackgroundClient<BackgroundJobSummary>();
    const nextUserTasks = new KanaUserTaskManager();
    nextUserTasks.create("Second session task");
    harness.session.subagents = nextSubagents;
    harness.session.jobs = nextJobs;
    harness.session.userTasks = nextUserTasks;

    harness.controller.bind();

    expect(harness.subagents.listenerCount()).toBe(0);
    expect(harness.renderEditor()).toContain("Second session");
    expect(harness.renderEditor()).not.toContain("First session");

    harness.userTasks.create("Stale task");
    expect(harness.renderEditor()).not.toContain("Stale task");

    harness.subagents.items.push(subagentSummary("agent_0000000000", "running", "Stale event"));
    harness.subagents.emit();
    expect(harness.renderEditor()).not.toContain("Stale event");

    harness.controller.unbind();
    expect(nextSubagents.listenerCount()).toBe(0);
    expect(nextJobs.listenerCount()).toBe(0);
    expect(harness.renderEditor()).not.toContain("Your tasks · ");
  });
});

function createHarness() {
  const editor = new Editor({ model: "test-model" });
  const tui = createTuiStub();
  const session: {
    subagents: BackgroundClientStub<KanaSubagentSummary>;
    jobs: BackgroundClientStub<BackgroundJobSummary>;
    userTasks: KanaUserTaskManager;
  } = {
    subagents: createBackgroundClient<KanaSubagentSummary>(),
    jobs: createBackgroundClient<BackgroundJobSummary>(),
    userTasks: new KanaUserTaskManager(),
  };
  const controller = new BackgroundActivityController({
    editor,
    tui,
    getJobs: () => session.jobs as unknown as BackgroundJobClient,
    getSubagents: () => session.subagents as unknown as KanaSubagentClient,
    getUserTasks: () => session.userTasks,
  });

  return {
    controller,
    session,
    subagents: session.subagents,
    jobs: session.jobs,
    userTasks: session.userTasks,
    renderEditor: () => stripAnsi(editor.render(96).join("\n")),
  };
}

function createTuiStub(): Tui {
  let focusedComponent: Component | undefined;

  return {
    requestRender: () => {},
    getFocus: () => focusedComponent,
    setFocus: (component: Component | undefined) => {
      focusedComponent = component;
    },
  } as unknown as Tui;
}
