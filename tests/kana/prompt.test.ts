import { describe, expect, test } from "bun:test";
import { BackgroundJobManager } from "../../src/jobs";
import { createBackgroundJobPromptSections } from "../../src/kana/background-jobs/prompt";
import type { KanaGoalSnapshot } from "../../src/kana/conversation/goal-controller";
import { buildKanaPromptAssembly } from "../../src/kana/prompt";
import type { KanaTodoItem } from "../../src/kana/todo";

describe("Kana prompt assembly", () => {
  test("projects explicit active and inactive durable todo states", async () => {
    let todoState: KanaTodoItem[] = [];
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      resolveTodoState: () => todoState,
    });
    const signal = new AbortController().signal;

    const empty = await assembly.assemble({ signal });
    expect(empty.context.find((snapshot) => snapshot.source === "todo")).toEqual({
      source: "todo",
      status: "inactive",
      content: "The current session todo list is empty.",
    });

    todoState = [
      { content: "Implement durable state", status: "in_progress" },
      { content: "Document the behavior", status: "pending" },
    ];
    const active = await assembly.assemble({ signal });
    expect(active.context.find((snapshot) => snapshot.source === "todo")).toEqual({
      source: "todo",
      status: "active",
      content: [
        "Current session todo state. todo_write replaces the complete list when updating it.",
        '{"items":[{"content":"Implement durable state","status":"in_progress"},{"content":"Document the behavior","status":"pending"}]}',
      ].join("\n"),
    });

    todoState = [
      { content: "Implement durable state", status: "completed" },
      { content: "Document the behavior", status: "completed" },
    ];
    const completed = await assembly.assemble({ signal });
    expect(completed.context.find((snapshot) => snapshot.source === "todo")?.content).toContain(
      '"status":"completed"',
    );

    todoState = [];
    const cleared = await assembly.assemble({ signal });
    expect(cleared.context.find((snapshot) => snapshot.source === "todo")).toEqual({
      source: "todo",
      status: "inactive",
      content: "The current session todo list is empty.",
    });
  });

  test("projects only the active goal objective and terminal guidance", async () => {
    let goal: KanaGoalSnapshot | undefined = {
      id: "goal-secret-id",
      objective: "Finish the refactor",
      status: "active",
      admittedRounds: 3,
      maxRounds: 8,
      startedAt: new Date("2026-08-24T00:00:00.000Z"),
    };
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      resolveGoalState: () => goal,
    });
    const signal = new AbortController().signal;

    const active = await assembly.assemble({ signal });
    const goalState = active.context.find((snapshot) => snapshot.source === "goal");
    expect(goalState?.status).toBe("active");
    const content = goalState?.content;
    expect(content).toContain('"objective":"Finish the refactor"');
    expect(content).toContain(
      "Call update_goal with completed only when the objective is achieved",
    );
    expect(content).not.toContain("goal-secret-id");
    expect(content).not.toContain("Round");
    expect(content).not.toContain('"maxRounds"');

    goal = { ...goal, status: "completed", endedAt: new Date("2026-08-24T01:00:00.000Z") };
    const completed = await assembly.assemble({ signal });
    expect(completed.context.find((snapshot) => snapshot.source === "goal")).toEqual({
      source: "goal",
      status: "inactive",
      content:
        "No user-authorized goal is currently active. Do not continue an earlier goal automatically.",
    });
  });

  test("projects only active or unreported Background Job state without output", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const background = createBackgroundJobPromptSections(jobs);
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      capabilitySystemSections: [background.system],
      capabilityContextSections: [background.context],
    });
    const signal = new AbortController().signal;
    let finish!: (value: { status: "completed"; exitCode: number }) => void;
    const completion = new Promise<{ status: "completed"; exitCode: number }>((resolve) => {
      finish = resolve;
    });

    const inactive = await assembly.assemble({ signal });
    expect(inactive.context.find((snapshot) => snapshot.source === "background-jobs")).toEqual({
      source: "background-jobs",
      status: "inactive",
      content: "The current session has no active or unreported Background Jobs.",
    });

    const job = jobs.start({
      kind: "bash",
      label: "bun run dev",
      cwd: ".",
      run: ({ write }) => {
        write("stdout", "secret output that must not enter runtime context");
        return completion;
      },
    });
    const running = await assembly.assemble({ signal });
    const runningContent = running.context.find(
      (snapshot) => snapshot.source === "background-jobs",
    )?.content;
    expect(runningContent).toContain(job.id);
    expect(runningContent).toContain('"status":"running"');
    expect(runningContent).not.toContain("secret output");

    finish({ status: "completed", exitCode: 0 });
    await waitFor(() => jobs.list()[0]?.status === "completed");
    const completed = await assembly.assemble({ signal });
    expect(
      completed.context.find((snapshot) => snapshot.source === "background-jobs")?.content,
    ).toContain('"status":"completed"');

    jobs.observe(job.id);
    const observed = await assembly.assemble({ signal });
    expect(observed.context.find((snapshot) => snapshot.source === "background-jobs")?.status).toBe(
      "inactive",
    );
    await manager.close();
  });
});

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
