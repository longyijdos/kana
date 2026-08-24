import { describe, expect, test } from "bun:test";

import { KanaGoalController } from "../../../src/kana/conversation/goal-controller";

describe("KanaGoalController", () => {
  test("admits bounded continuations and closes at the configured limit", () => {
    const controller = new KanaGoalController();

    const started = controller.start("  Finish the feature  ", 2);
    expect(started).toMatchObject({
      objective: "Finish the feature",
      status: "active",
      admittedRounds: 1,
      maxRounds: 2,
    });
    expect(controller.admitContinuation()).toMatchObject({
      type: "admitted",
      goal: { admittedRounds: 2, status: "active" },
    });
    expect(controller.admitContinuation()).toMatchObject({
      type: "round_limit",
      goal: { admittedRounds: 2, status: "round_limit", endedAt: expect.any(Date) },
    });
    expect(controller.admitContinuation()).toBeUndefined();
  });

  test("accepts only explicit terminal updates for an active goal", () => {
    const controller = new KanaGoalController();
    controller.start("Finish the feature", 8);

    const completed = controller.update({ status: "completed", detail: "  Checks pass.  " });
    expect(completed).toMatchObject({
      status: "completed",
      detail: "Checks pass.",
      endedAt: expect.any(Date),
    });
    expect(controller.active).toBeUndefined();
    expect(() => controller.update({ status: "blocked" })).toThrow(
      "There is no active goal to update.",
    );
  });

  test("cancels or discards process-local active state", () => {
    const controller = new KanaGoalController();
    controller.start("First goal", 8);

    expect(controller.cancel()).toMatchObject({ status: "cancelled" });
    expect(controller.cancel()).toBeUndefined();

    controller.start("Second goal", 8);
    expect(controller.discard()).toMatchObject({
      objective: "Second goal",
      status: "cancelled",
    });
    expect(controller.current).toBeUndefined();
  });

  test("rejects invalid objectives and round limits", () => {
    const controller = new KanaGoalController();

    expect(() => controller.start("", 8)).toThrow(
      "Goal objective must contain between 1 and 4000 characters.",
    );
    expect(() => controller.start("Valid objective", 0)).toThrow(
      "Goal max rounds must be a positive integer.",
    );
  });
});
