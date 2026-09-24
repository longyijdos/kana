import { Type } from "typebox";

import { strictObject, type Tool } from "@/tools";
import type { KanaUserTaskManager } from "../user-tasks";

export const delegateUserTaskParameters = strictObject({
  task: Type.String({
    minLength: 1,
    maxLength: 4_000,
    description: "A specific, self-contained task the user can do while you continue your work.",
  }),
});

export function createDelegateUserTaskTool(
  tasks: KanaUserTaskManager,
): Tool<typeof delegateUserTaskParameters> {
  return {
    name: "delegate_user_task",
    description:
      "Invite the user to take a small, concrete task in parallel with your work. The user may decline; then do that task yourself. If accepted, continue your own work without waiting. You will receive a separate update when the user completes or returns the task.",
    parameters: delegateUserTaskParameters,
    execution: { concurrency: "exclusive" },
    execute: ({ task }) => {
      const created = tasks.create(task);
      return {
        content: `User accepted task ${created.id}. Continue your work; the user's result will arrive separately.`,
        result: { status: "accepted", taskId: created.id },
      };
    },
  };
}
