import { describe, expect, test } from "bun:test";
import { KanaUserTaskManager } from "../../src/kana/user-tasks";

describe("Kana user tasks", () => {
  test("keeps accepted tasks visible until their user update is observed", () => {
    const tasks = new KanaUserTaskManager();
    const updates: Array<{ id: string; status: string; response: string }> = [];
    tasks.subscribe(({ task, response }) => {
      updates.push({ id: task.id, status: task.status, response });
    });
    const first = tasks.create("Review the screenshot");
    const second = tasks.create("Check the wording");

    expect(tasks.context().map((task) => task.status)).toEqual(["pending", "pending"]);
    tasks.done(first.id, "The labels look good.");
    tasks.returnToAgent(second.id, "I cannot access the draft.");

    expect(updates).toEqual([
      { id: first.id, status: "done", response: "The labels look good." },
      { id: second.id, status: "returned", response: "I cannot access the draft." },
    ]);
    expect(tasks.context().map((task) => task.status)).toEqual(["done", "returned"]);
    tasks.observe(first.id);
    tasks.observe(second.id);
    expect(tasks.context()).toEqual([]);
  });
});
