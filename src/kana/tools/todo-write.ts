import { Type } from "typebox";

import type { Tool } from "@/tools";
import { strictObject } from "@/tools";
import {
  formatKanaTodoWriteAcknowledgement,
  type KanaTodoItem,
  type KanaTodoStateChange,
  normalizeKanaTodoItems,
} from "../todo";

const todoItemParameters = strictObject({
  content: Type.String({
    minLength: 1,
    description: "A concrete task described in non-empty text.",
  }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
});

export const todoWriteParameters = strictObject({
  items: Type.Array(todoItemParameters, {
    description:
      "The complete replacement list. Pass an empty array to clear the current session list.",
  }),
});

export type TodoWriteToolResult = {
  status: "updated" | "cleared";
};

export type TodoWriteToolOptions = {
  commit?: (change: KanaTodoStateChange) => Promise<void> | void;
};

export function createTodoWriteTool(
  options: TodoWriteToolOptions = {},
): Tool<typeof todoWriteParameters, TodoWriteToolResult> {
  return {
    name: "todo_write",
    description:
      "Replace the complete session todo list for multi-step work. Keep at most one item in_progress, include every still-relevant item on each call, and pass an empty list to clear it. Do not use this tool for simple single-step work.",
    parameters: todoWriteParameters,
    execution: {
      concurrency: "exclusive",
    },
    execute: async (args, context) => {
      const items: KanaTodoItem[] = normalizeKanaTodoItems(args.items);
      await options.commit?.({
        toolCallId: context.toolCallId,
        items: structuredClone(items),
      });

      return {
        content: formatKanaTodoWriteAcknowledgement(items),
        result: {
          status: items.length === 0 ? "cleared" : "updated",
        },
      };
    },
  };
}
