import { describe, expect, test } from "bun:test";

import type { KanaGoalUpdate } from "../../../src/kana/conversation/goal-controller";
import { createUpdateGoalTool } from "../../../src/kana/tools/update-goal";
import { validateToolArguments } from "../../../src/tools/validation";

describe("Kana update_goal tool", () => {
  test("commits an explicit terminal state with a compact acknowledgement", async () => {
    const updates: KanaGoalUpdate[] = [];
    const tool = createUpdateGoalTool({
      update: (change) => {
        updates.push(change);
        return {
          id: "goal-1",
          objective: "Finish the feature",
          status: change.status,
          admittedRounds: 2,
          maxRounds: 8,
          startedAt: new Date("2026-08-24T00:00:00.000Z"),
          endedAt: new Date("2026-08-24T01:00:00.000Z"),
          detail: change.detail,
        };
      },
    });

    const output = await tool.execute(
      { status: "blocked", detail: "Needs user credentials." },
      { toolCallId: "call-goal", update() {} },
    );

    expect(updates).toEqual([{ status: "blocked", detail: "Needs user credentials." }]);
    expect(output).toMatchObject({
      content: "Goal marked blocked.",
      result: { id: "goal-1", status: "blocked" },
    });
    if (!("content" in output)) {
      throw new Error("Expected a wrapped tool result.");
    }
    expect(output.content).not.toContain("round");
  });

  test("uses a strict terminal-state schema", () => {
    const tool = createUpdateGoalTool({
      update: () => {
        throw new Error("not reached");
      },
    });

    expect(() => validateToolArguments(tool, { status: "cancelled" })).toThrow(
      "status: must match a schema in anyOf",
    );
    expect(() => validateToolArguments(tool, { status: "completed", rounds: 3 })).toThrow(
      "rounds: Unexpected property",
    );
  });
});
