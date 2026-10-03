import { describe, expect, test } from "bun:test";
import type { ToolCallContent } from "../../src/core";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import { formatToolInspector } from "../../src/tui/tools";

describe("tool inspector", () => {
  test("separates run_code source, output, return value, and nested call results", () => {
    const call = toolCall("run_code", { code: "text('ready');\nreturn false;" });
    const rendered = renderInspector(
      call,
      {
        ok: true,
        value: false,
        output: [
          { type: "text", text: "ready\ncomplete" },
          { type: "image", data: "hidden image payload", mimeType: "image/png" },
        ],
        calls: [
          { name: "read", status: "error", durationMs: 8.2 },
          { name: "shell", status: "ok", durationMs: 15 },
        ],
        storeWrites: { set: {}, delete: [] },
      },
      false,
      "done",
    );
    expect(rendered).toEqual([
      "Code",
      "  text('ready');",
      "  return false;",
      "",
      "Output",
      "  ready",
      "  complete",
      "",
      "Return value",
      "  false",
      "",
      "Tool calls",
      "  read · error · 8 ms",
      "  shell · ok · 15 ms",
    ]);
    const failed = renderInspector(
      call,
      {
        ok: false,
        error: { kind: "script", message: "failed", stack: "Error: failed\n  at script:2" },
        output: [],
        calls: [{ name: "shell", status: "cancelled", durationMs: 3 }],
      },
      true,
      "failed",
    );
    expect(failed).toContain("  Failed");
    expect(failed).toContain("Error");
    expect(failed).toContain("    at script:2");
    expect(failed).toContain("  shell · cancelled · 3 ms");
    const running = renderInspector(call, undefined, false, "running");
    expect(running).toContain("  return false;");
    expect(running).toContain("  Running");
  });

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
        edits: [
          { oldText: "old line", newText: "new line" },
          { oldText: "old value", newText: "new value" },
        ],
      }),
      {
        path: "src/app.ts",
        replacements: 2,
        bytesWritten: 18,
      },
      false,
      "done",
    );

    expect(edit.filter((line) => line.startsWith("- "))).toEqual(["- old line", "- old value"]);
    expect(edit.filter((line) => line.startsWith("+ "))).toEqual(["+ new line", "+ new value"]);
    expect(edit).not.toContain("edits[0]");
    expect(edit).not.toContain("edits[1]");
    expect(edit).not.toContain("Replace");
    expect(edit).not.toContain("With");
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

  test("keeps edit arguments before successful structured output", () => {
    const call = toolCall("edit", {
      path: "src/app.ts",
      edits: [{ oldText: "old text", newText: "new text" }],
    });
    const cases = [
      { result: undefined, isError: false, state: "running" as const },
      { result: { error: "not found" }, isError: true, state: "failed" as const },
    ];

    for (const entry of cases) {
      const rendered = renderInspector(call, entry.result, entry.isError, entry.state);

      expect(rendered).toContain("edits[0] · Replace");
      expect(rendered).toContain("  old text");
      expect(rendered).toContain("edits[0] · With");
      expect(rendered).toContain("  new text");
    }

    const deletion = renderInspector(
      toolCall("edit", {
        path: "foo.ts",
        edits: [{ oldText: "obsolete code", newText: "" }],
      }),
      undefined,
      false,
      "running",
    );
    expect(deletion).toContain("edits[0] · With");
  });

  test("wraps long detail fields within the inspector width", () => {
    const command = `python command.py --foo ${"x".repeat(120)} --bar value`;
    const rendered = formatToolInspector(
      toolCall("shell", { command }),
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
