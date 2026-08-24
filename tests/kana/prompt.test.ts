import { describe, expect, test } from "bun:test";
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
});
