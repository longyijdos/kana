import { describe, expect, test } from "bun:test";

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
});
