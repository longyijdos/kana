import { describe, expect, test } from "bun:test";
import type { ToolCallContent } from "../../src/core";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import { formatToolInspector } from "../../src/tui/tools";

describe("tool inspector", () => {
  test("renders successful write and edit payloads once through specialized output", () => {
    const write = renderInspector(
      toolCall("write", { path: "src/data.ts", content: "line 1\nline 2" }),
      { path: "src/data.ts", bytesWritten: 13 },
      false,
      "done",
    );

    expect(write.filter((line) => line.startsWith("+ "))).toEqual(["+ line 1", "+ line 2"]);
    expect(write).not.toContain("Content");

    const edit = renderInspector(
      toolCall("edit", {
        path: "src/app.ts",
        oldText: "old line",
        newText: "new line",
        replaceAll: true,
      }),
      {
        path: "src/app.ts",
        replacements: 1,
        oldText: "old line",
        newText: "new line",
      },
      false,
      "done",
    );

    expect(edit.filter((line) => line.startsWith("- "))).toEqual(["- old line"]);
    expect(edit.filter((line) => line.startsWith("+ "))).toEqual(["+ new line"]);
    expect(edit).not.toContain("Replace");
    expect(edit).not.toContain("With");
    expect(edit.join("\n")).toContain("Replace all");
  });

  test("keeps write arguments available before successful structured output", () => {
    const call = toolCall("write", { path: "src/data.ts", content: "line 1\nline 2" });
    const cases = [
      { result: undefined, isError: false, state: "running" as const, status: "Running" },
      {
        result: { error: "disk full" },
        isError: true,
        state: "failed" as const,
        status: "Failed",
      },
      { result: undefined, isError: false, state: "canceled" as const, status: "Canceled" },
    ];

    for (const entry of cases) {
      const rendered = renderInspector(call, entry.result, entry.isError, entry.state);

      expect(rendered).toContain("Content");
      expect(rendered).toContain("  line 2");
      expect(rendered).toContain(`  ${entry.status}`);
    }
  });

  test("keeps edit arguments when the result cannot supply a diff", () => {
    const call = toolCall("edit", {
      path: "src/app.ts",
      oldText: "old text",
      newText: "new text",
    });
    const cases = [
      { result: undefined, isError: false, state: "running" as const },
      { result: { error: "not found" }, isError: true, state: "failed" as const },
      { result: { path: "src/app.ts", replacements: 1 }, isError: false, state: "done" as const },
    ];

    for (const entry of cases) {
      const rendered = renderInspector(call, entry.result, entry.isError, entry.state);

      expect(rendered).toContain("Replace");
      expect(rendered).toContain("  old text");
      expect(rendered).toContain("With");
      expect(rendered).toContain("  new text");
    }

    const deletion = renderInspector(
      toolCall("edit", { path: "foo.ts", oldText: "obsolete code", newText: "" }),
      undefined,
      false,
      "running",
    );
    expect(deletion).toContain("With");
  });

  test("wraps long detail fields within the inspector width", () => {
    const command = `python command.py --foo ${"x".repeat(120)} --bar value`;
    const rendered = formatToolInspector(
      toolCall("bash", { command }),
      undefined,
      false,
      "running",
      58,
    ).map(stripAnsi);

    expect(rendered.every((line) => visibleWidth(line) <= 58)).toBe(true);
    expect(rendered.map((line) => line.replace(/^ {2}/, "")).join("")).toContain(command);
  });
});

function toolCall(name: string, args: unknown): ToolCallContent {
  return { type: "tool_call", id: `call-${name}`, name, args };
}

function renderInspector(
  call: ToolCallContent,
  result: unknown,
  isError: boolean,
  state: "running" | "done" | "failed" | "canceled",
): string[] {
  return formatToolInspector(call, result, isError, state, 80).map(stripAnsi);
}
