import { describe, expect, test } from "bun:test";
import { ToolCallBlock } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";

describe("tool call block", () => {
  test("renders user-canceled local tools separately from failures", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_canceled",
      name: "read",
      args: {
        path: "src/app.ts",
      },
    });
    block.markExecutionStarted();
    block.updateResult(
      {
        status: "canceled",
        reason: "run_aborted",
        message: "Tool execution was canceled because the agent run was aborted.",
      },
      true,
    );

    const rendered = block.render(80).map(stripAnsi);

    expect(rendered).toEqual(["◆ Canceled reading", "  └ src/app.ts"]);
    expect(rendered.join("\n")).not.toContain("Failed");
  });

  test("keeps artifact output compact while exposing retrieval metadata in the viewer", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_artifact",
      name: "bash",
      args: { command: "generate lots of output" },
    });
    const locator = "/tmp/kana-artifacts/session/large-output.txt";
    block.updateResult({ kind: "text", locator, byteLength: 83 * 1_024 }, false);

    expect(block.render(100).map(stripAnsi)).toContain("Output stored · 83 KB");
    expect(block.hasExpandableOutput()).toBe(true);

    const expanded = block.getToolDetailView().render(100).map(stripAnsi).join("\n");
    expect(expanded).toContain(`Full output locator: ${locator}`);
    expect(expanded).toContain("Use grep with this locator plus pattern");
  });

  test("renders a completed remember call as one visible line", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_remember",
      name: "remember",
      args: {
        content: "Use Chinese by default.",
      },
    });
    block.updateResult(
      {
        id: "mem_123",
        createdAt: "2026-06-20T14:32:00.000Z",
        scope: "global",
      },
      false,
    );

    const rendered = block.render(80).map(stripAnsi).filter(Boolean);

    expect(rendered).toEqual(["◆ Saved memory", "  └ global"]);
  });

  test("renders a completed scheduled wake as a compact semantic tool block", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_wake",
      name: "schedule_wake",
      args: {
        afterMinutes: 30,
        message: "Check the task.",
      },
    });
    block.updateResult(
      {
        id: "wake_123",
        dueAt: "2026-06-24T08:30:00.000Z",
      },
      false,
    );

    const rendered = block.render(80).map(stripAnsi).filter(Boolean);

    expect(rendered).toEqual(["◆ Scheduled wake", "  └ in 30 minutes Check the task."]);
  });

  test("renders accepted todo state compactly and keeps the complete snapshot in details", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_todo",
      name: "todo_write",
      args: {
        items: [
          { content: "Implement persistence", status: "in_progress" },
          { content: "Update documentation", status: "pending" },
          { content: "Inspect the issue", status: "completed" },
        ],
      },
    });
    block.updateTodoState([
      { content: "Implement persistence", status: "in_progress" },
      { content: "Update documentation", status: "pending" },
      { content: "Inspect the issue", status: "completed" },
    ]);
    block.updateResult({ status: "updated" }, false);

    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Updated todos",
      "  └ 1 active · 1 pending · 1 completed · Implement persistence",
    ]);
    expect(block.hasExpandableOutput()).toBe(false);
    expect(block.getToolDetailView().render(100).map(stripAnsi)).toEqual([
      "Output",
      "1 active · 1 pending · 1 completed",
      "",
      "◉ Implement persistence",
      "○ Update documentation",
      "✓ Inspect the issue",
    ]);
  });

  test("renders an explicit empty todo replacement as cleared", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_todo_clear",
      name: "todo_write",
      args: { items: [] },
    });
    block.updateTodoState([]);
    block.updateResult({ status: "cleared" }, false);

    expect(block.render(80).map(stripAnsi)).toEqual(["◆ Cleared todos"]);
    expect(block.getToolDetailView().render(80).map(stripAnsi)).toEqual(["Output", "No todos."]);
  });

  test("renders todo running, failure, and cancellation states semantically", () => {
    let now = 0;
    const failed = new ToolCallBlock(
      {
        type: "tool_call",
        id: "call_todo_failed",
        name: "todo_write",
        args: { items: [{ content: "Invalid list", status: "pending" }] },
      },
      () => now,
    );
    failed.markExecutionStarted();
    now = 2_000;
    expect(failed.render(80).map(stripAnsi)).toEqual(["◆ Updating todos (2s) (Esc to abort)"]);
    failed.updateResult({ error: "Duplicate todo item content." }, true);
    expect(failed.render(80).map(stripAnsi)).toEqual([
      "◆ Failed to update todos",
      "Duplicate todo item content.",
    ]);

    const canceled = new ToolCallBlock({
      type: "tool_call",
      id: "call_todo_canceled",
      name: "todo_write",
      args: { items: [{ content: "Canceled list", status: "pending" }] },
    });
    canceled.updateResult(
      {
        status: "canceled",
        reason: "run_aborted",
        message: "Tool execution was canceled because the agent run was aborted.",
      },
      true,
    );
    expect(canceled.render(80).map(stripAnsi)).toEqual(["◆ Canceled updating todos"]);
  });

  test("inspects read tool detail without dumping the file content", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "read",
      args: {
        path: "AGENTS.md",
      },
    });

    block.updateResult(
      {
        path: "AGENTS.md",
        content: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
        startLine: 1,
        endLine: 10,
        totalLines: 10,
      },
      false,
    );

    const view = block.getToolDetailView();
    const rendered = view.render(100).map(stripAnsi).join("\n");
    expect(rendered).toContain("Path");
    expect(rendered).toContain("AGENTS.md:1-10 of 10");
    expect(rendered).not.toContain("line 10");
  });

  test("invalidates tool call cache when partial and final results change", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: {
        command: "bun test",
      },
    });

    block.markExecutionStarted();
    block.updatePartialResult("running");

    const partialRendered = stripAnsi(block.render(80).join("\n"));

    expect(partialRendered).toContain("◆ Running (0s) (Esc to abort)");
    expect(partialRendered).toContain("running");

    block.updateResult("done", false);

    const rendered = stripAnsi(block.render(80).join("\n"));

    expect(rendered).toContain("done");
    expect(rendered).not.toContain("running");
  });

  test("does not render output shortcut hints in tool titles", () => {
    const first = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: {
        command: "first",
      },
    });
    const second = new ToolCallBlock({
      type: "tool_call",
      id: "call_2",
      name: "bash",
      args: {
        command: "second",
      },
    });

    first.updateResult(
      {
        command: "first",
        exitCode: 0,
        stdout: Array.from({ length: 10 }, (_, index) => `first line ${index + 1}`).join("\n"),
      },
      false,
    );
    second.updateResult(
      {
        command: "second",
        exitCode: 0,
        stdout: Array.from({ length: 10 }, (_, index) => `second line ${index + 1}`).join("\n"),
      },
      false,
    );
    const lines = [...first.render(100), ...second.render(100)].map(stripAnsi);

    expect(lines).toContain("◆ Ran");
    expect(lines).toContain("  └ first");
    expect(lines).toContain("  └ second");
    expect(lines.join("\n")).not.toContain("Ctrl+O");
  });
});
