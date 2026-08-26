import { describe, expect, test } from "bun:test";
import { BackgroundJobManager } from "../../src/jobs";
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
      content: '{"items":[]}',
    });

    todoState = [
      { content: "Implement durable state", status: "in_progress" },
      { content: "Document the behavior", status: "pending" },
    ];
    const active = await assembly.assemble({ signal });
    expect(active.context.find((snapshot) => snapshot.source === "todo")).toEqual({
      source: "todo",
      status: "active",
      content:
        '{"items":[{"content":"Implement durable state","status":"in_progress"},{"content":"Document the behavior","status":"pending"}]}',
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
      content: '{"items":[]}',
    });
  });

  test("projects only the active goal authorization and objective", async () => {
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
    expect(goalState).toEqual({
      source: "goal",
      status: "active",
      content: '{"authorized":true,"objective":"Finish the refactor"}',
    });

    goal = { ...goal, status: "completed", endedAt: new Date("2026-08-24T01:00:00.000Z") };
    const completed = await assembly.assemble({ signal });
    expect(completed.context.find((snapshot) => snapshot.source === "goal")).toEqual({
      source: "goal",
      status: "inactive",
      content: '{"authorized":false}',
    });
  });

  test("projects only active or unreported Background Job state without output", async () => {
    const manager = new BackgroundJobManager();
    const jobs = manager.bind(manager.createOwner("session-a"), { maxConcurrent: 1 });
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      resolveBackgroundJobState: () => jobs.context(),
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
      content: '{"jobs":[]}',
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
