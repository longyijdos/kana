import { describe, expect, test } from "bun:test";
import type { KanaTodoStateChange } from "../../../src/kana/todo";
import { createTodoWriteTool } from "../../../src/kana/tools/todo-write";
import { validateToolArguments } from "../../../src/tools/validation";

describe("Kana todo_write tool", () => {
  test("commits a normalized whole-list replacement with a compact result", async () => {
    const changes: KanaTodoStateChange[] = [];
    const tool = createTodoWriteTool({
      commit: (change) => {
        changes.push(structuredClone(change));
      },
    });

    const output = await tool.execute(
      {
        items: [
          { content: "  Inspect the journal  ", status: "completed" },
          { content: "Implement todo state", status: "in_progress" },
          { content: "Update documentation", status: "pending" },
        ],
      },
      { toolCallId: "call-todo", update() {} },
    );

    expect(changes).toEqual([
      {
        toolCallId: "call-todo",
        items: [
          { content: "Inspect the journal", status: "completed" },
          { content: "Implement todo state", status: "in_progress" },
          { content: "Update documentation", status: "pending" },
        ],
      },
    ]);
    expect(output).toEqual({
      content: "Todo list updated.",
      result: { status: "updated" },
    });
    expect(JSON.stringify(output)).not.toContain("Implement todo state");
  });

  test("accepts an explicit empty replacement as the only clear operation", async () => {
    const changes: KanaTodoStateChange[] = [];
    const tool = createTodoWriteTool({
      commit: (change) => {
        changes.push(change);
      },
    });

    const output = await tool.execute({ items: [] }, { toolCallId: "call-clear", update() {} });

    expect(changes).toEqual([{ toolCallId: "call-clear", items: [] }]);
    expect(output).toEqual({
      content: "Todo list cleared.",
      result: { status: "cleared" },
    });
  });

  test("rejects invalid lists without committing partial state", async () => {
    const changes: KanaTodoStateChange[] = [];
    const tool = createTodoWriteTool({
      commit: (change) => {
        changes.push(change);
      },
    });
    const context = { toolCallId: "call-invalid", update() {} };

    await expect(
      tool.execute(
        {
          items: [
            { content: "Same item", status: "pending" },
            { content: " Same item ", status: "completed" },
          ],
        },
        context,
      ),
    ).rejects.toThrow("Duplicate todo item content: Same item");
    await expect(
      tool.execute(
        {
          items: [
            { content: "First active", status: "in_progress" },
            { content: "Second active", status: "in_progress" },
          ],
        },
        context,
      ),
    ).rejects.toThrow("at most one in_progress item");
    await expect(
      tool.execute({ items: [{ content: "   ", status: "pending" }] }, context),
    ).rejects.toThrow("content cannot be blank");
    expect(changes).toEqual([]);
  });

  test("uses strict schemas for the list and each item", () => {
    const tool = createTodoWriteTool();

    expect(() =>
      validateToolArguments(tool, {
        items: [{ content: "Implement it", status: "pending", priority: "high" }],
      }),
    ).toThrow("items.0.priority: Unexpected property");
    expect(() =>
      validateToolArguments(tool, {
        items: [{ content: "Implement it", status: "blocked" }],
      }),
    ).toThrow("items.0.status: must match a schema in anyOf");
  });
});
