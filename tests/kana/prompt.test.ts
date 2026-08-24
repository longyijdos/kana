import { describe, expect, test } from "bun:test";
import type { KanaGoalSnapshot } from "../../src/kana/conversation/goal-controller";
import { buildKanaPromptAssembly } from "../../src/kana/prompt";
import type { KanaTodoItem } from "../../src/kana/todo";

describe("Kana prompt assembly", () => {
  test("projects the current durable todo state and removes the source only when cleared", async () => {
    let todoState: KanaTodoItem[] = [];
    const assembly = buildKanaPromptAssembly({
      launchMode: "clean",
      resolveTodoState: () => todoState,
    });
    const signal = new AbortController().signal;

    const empty = await assembly.assemble({ signal });
    expect(empty.context.map((snapshot) => snapshot.source)).toEqual(["environment"]);

    todoState = [
      { content: "Implement durable state", status: "in_progress" },
      { content: "Document the behavior", status: "pending" },
    ];
    const active = await assembly.assemble({ signal });
    expect(active.context.find((snapshot) => snapshot.source === "todo")?.content).toBe(
      [
        "Current session todo state. todo_write replaces the complete list when updating it.",
        '{"items":[{"content":"Implement durable state","status":"in_progress"},{"content":"Document the behavior","status":"pending"}]}',
      ].join("\n"),
    );

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
    expect(cleared.context.some((snapshot) => snapshot.source === "todo")).toBe(false);
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
    const content = active.context.find((snapshot) => snapshot.source === "goal")?.content;
    expect(content).toContain('"objective":"Finish the refactor"');
    expect(content).toContain(
      "Call update_goal with completed only when the objective is achieved",
    );
    expect(content).not.toContain("goal-secret-id");
    expect(content).not.toContain("Round");
    expect(content).not.toContain('"maxRounds"');

    goal = { ...goal, status: "completed", endedAt: new Date("2026-08-24T01:00:00.000Z") };
    const completed = await assembly.assemble({ signal });
    expect(completed.context.some((snapshot) => snapshot.source === "goal")).toBe(false);
  });
});
