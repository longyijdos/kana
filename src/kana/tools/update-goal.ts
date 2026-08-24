import { Type } from "typebox";

import type { Tool } from "@/tools";
import { strictObject } from "@/tools";
import type { KanaGoalSnapshot, KanaGoalUpdate } from "../conversation/goal-controller";

export const updateGoalParameters = strictObject({
  status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")], {
    description:
      "Use completed only when the objective is achieved; use blocked when progress requires user input or an external state change.",
  }),
  detail: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 2_000,
      description: "A concise blocker or completion detail.",
    }),
  ),
});

export type UpdateGoalToolOptions = {
  update: (change: KanaGoalUpdate) => KanaGoalSnapshot;
};

export function createUpdateGoalTool(
  options: UpdateGoalToolOptions,
): Tool<typeof updateGoalParameters, KanaGoalSnapshot> {
  return {
    name: "update_goal",
    description:
      "End the active goal continuation. Mark it completed only when the objective is actually achieved, or blocked only when meaningful progress cannot continue without user input or an external state change. Do not call this while you can still make meaningful progress.",
    parameters: updateGoalParameters,
    execution: {
      concurrency: "exclusive",
    },
    execute: (args) => {
      const goal = options.update({
        status: args.status,
        ...(args.detail === undefined ? {} : { detail: args.detail }),
      });
      return {
        content: `Goal marked ${goal.status}.`,
        result: goal,
      };
    },
  };
}
