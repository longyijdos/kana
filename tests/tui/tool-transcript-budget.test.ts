import { describe, expect, test } from "bun:test";
import type { ToolCallContent } from "../../src/core";
import { HostedToolBlock, ToolCallBlock } from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import { formatToolApproval } from "../../src/tui/tools";

const WIDTH = 80;
// Compact tool block shape: 1 title row + 1 target row + at most 9 output
// rows (edit: replacements + 3 old + 3 new + 2 omission markers).
const MAX_TOOL_ROWS = 11;

describe("compact tool transcript bounds", () => {
  test("keeps a very long Bash command on one target row without changing arguments or approval details", () => {
    const command = `python -c '${"print(1);".repeat(20_000)}' > result.json`;
    const toolCall: ToolCallContent = {
      type: "tool_call",
      id: "long-bash-target",
      name: "bash",
      args: { command },
    };
    const block = new ToolCallBlock(toolCall);

    block.markExecutionStarted();
    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.length).toBe(2);
    expect(compact[1]).toContain("...");
    expect(compact.every((line) => visibleWidth(line) <= WIDTH)).toBe(true);

    // Canonical arguments and approval details stay complete.
    expect((toolCall.args as { command: string }).command).toBe(command);
    expect(formatToolApproval(toolCall).detail).toBe(
      `Command\n  ${command}\n\nWorking directory\n  .\n\nExecution\n  Foreground\n\nTimeout\n  30000 ms`,
    );
  });

  test("bounds a one-line multi-megabyte Bash stdout while the full result view keeps it complete", () => {
    const stdout = "x".repeat(2 * 1_024 * 1_024);
    const block = completedBlock(
      "bash",
      { command: "generate" },
      { command: "generate", exitCode: 0, stdout },
    );

    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.length).toBeLessThanOrEqual(3);
    expect(compact.every((line) => visibleWidth(line) <= WIDTH)).toBe(true);
    expect(block.hasExpandableOutput()).toBe(true);

    const full = block.getToolDetailView().render(WIDTH).map(stripAnsi).join("");
    expect(full).toContain(stdout);
  }, 20_000);

  test("marks omitted multi-line Bash output with an explicit old-style indicator", () => {
    const stdout = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const block = completedBlock(
      "bash",
      { command: "count" },
      { command: "count", exitCode: 0, stdout },
    );

    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.length).toBeLessThanOrEqual(MAX_TOOL_ROWS);
    expect(compact).toContain("... 92 more lines");
    expect(compact).toContain("line 93");
    expect(compact).toContain("line 100");
    expect(compact).not.toContain("line 92");
    expect(block.hasExpandableOutput()).toBe(true);

    const full = block.getToolDetailView().render(WIDTH).map(stripAnsi);
    expect(full).toContain("line 1");
  });

  test("bounds a huge single-line write preview without touching the canonical content", () => {
    const content = "const value = 1;".repeat(30_000);
    const args = { path: "src/generated.ts", content };
    const block = completedBlock("write", args, {
      path: args.path,
      bytesWritten: Buffer.byteLength(content),
    });

    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.length).toBeLessThanOrEqual(4);
    expect(compact.every((line) => visibleWidth(line) <= WIDTH)).toBe(true);
    expect(args.content).toBe(content);
    expect(block.hasExpandableOutput()).toBe(true);

    const full = block.getToolDetailView().render(WIDTH).map(stripAnsi);
    expect(full.length).toBeGreaterThan(MAX_TOOL_ROWS);
  });

  test("keeps a multi-line write preview to 7 content rows after the bytes row", () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const args = { path: "src/data.ts", content };
    const block = completedBlock("write", args, {
      path: args.path,
      bytesWritten: Buffer.byteLength(content),
    });

    const compact = block.render(WIDTH).map(stripAnsi);

    // 1 title + 1 target + 1 byte-count row + 1 omission marker + 7 content rows.
    expect(compact.length).toBeLessThanOrEqual(11);
    expect(compact.join("\n")).toContain("... 23 more lines");
    expect(compact).toContain("+ line 24");
    expect(compact).toContain("+ line 30");
    expect(compact.join("\n")).not.toContain("+ line 23");
    expect(block.hasExpandableOutput()).toBe(true);

    const full = block.getToolDetailView().render(WIDTH).map(stripAnsi);
    expect(full).toContain("+ line 1");
    expect(full).toContain("+ line 30");
  });

  test("bounds a large edit diff and exposes the complete diff through the result view", () => {
    const oldText = Array.from({ length: 500 }, (_, index) => `old line ${index + 1}`).join("\n");
    const newText = Array.from({ length: 500 }, (_, index) => `new line ${index + 1}`).join("\n");
    const block = completedBlock(
      "edit",
      { path: "src/app.ts", oldText, newText },
      { path: "src/app.ts", replacements: 1, oldText, newText },
    );

    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.length).toBeLessThanOrEqual(MAX_TOOL_ROWS);
    expect(compact.join("\n")).toContain("... 497 more lines");
    expect(compact.some((line) => line.startsWith("- "))).toBe(true);
    expect(compact.some((line) => line.startsWith("+ "))).toBe(true);
    expect(compact.join("\n")).toContain("- old line 500");
    expect(compact.join("\n")).toContain("+ new line 500");
    expect(compact.join("\n")).not.toContain("- old line 497");
    expect(compact.join("\n")).not.toContain("+ new line 497");
    expect(block.hasExpandableOutput()).toBe(true);

    const full = block.getToolDetailView().render(WIDTH).map(stripAnsi);
    expect(full).toContain("- old line 1");
    expect(full).toContain("- old line 500");
    expect(full).toContain("+ new line 500");
  });

  test("wraps a super-wide single-line edit diff in the full result view", () => {
    const oldText = "o".repeat(1_000);
    const newText = "n".repeat(1_000);
    const block = completedBlock(
      "edit",
      { path: "src/app.ts", oldText, newText },
      { path: "src/app.ts", replacements: 1, oldText, newText },
    );

    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.every((line) => visibleWidth(line) <= WIDTH)).toBe(true);
    expect(compact.some((line) => line.startsWith("- ") && line.endsWith("..."))).toBe(true);
    expect(block.hasExpandableOutput()).toBe(true);

    const full = block.getToolDetailView().render(WIDTH).map(stripAnsi);

    // Full rows wrap to the viewer content width instead of staying overlong
    // and getting truncated again by the viewer. The rendered rows include
    // the 2-column "- "/"+ " prefix, so the bound here is the full WIDTH.
    expect(full.length).toBeGreaterThan(2);
    expect(full.every((line) => visibleWidth(line) <= WIDTH)).toBe(true);
    const diffRows = full.filter((line) => line.startsWith("- ") || line.startsWith("+ "));
    expect(diffRows.join("").split("o").length - 1).toBe(1_000);
    expect(diffRows.join("").split("n").length - 1).toBe(1_000);
  });

  test("bounds huge generic MCP/custom fallback JSON with a clear omission indication", () => {
    const result = {
      items: Array.from({ length: 10_000 }, (_, index) => ({
        index,
        text: "payload".repeat(100),
      })),
    };
    const block = completedBlock("mcp__server__large_result", {}, result);

    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.length).toBeLessThanOrEqual(MAX_TOOL_ROWS);
    expect(compact.join("\n")).toMatch(/\.\.\. \d+ more lines/);
    expect(result.items).toHaveLength(10_000);
    expect(block.hasExpandableOutput()).toBe(true);

    const full = block.getToolDetailView().render(WIDTH).map(stripAnsi).join("\n");
    expect(full).toContain('"index": 9999');
  });

  test("bounds huge primitive and error strings and keeps both expandable", () => {
    const primitive = "primitive".repeat(30_000);
    const error = "failure".repeat(30_000);
    const primitiveBlock = completedBlock("custom_primitive", {}, primitive);
    const errorBlock = completedBlock("custom_error", {}, { error }, true);

    for (const block of [primitiveBlock, errorBlock]) {
      const compact = block.render(WIDTH).map(stripAnsi);

      expect(compact.length).toBeLessThanOrEqual(MAX_TOOL_ROWS);
      expect(compact.every((line) => visibleWidth(line) <= WIDTH)).toBe(true);
      expect(block.hasExpandableOutput()).toBe(true);

      const full = block.getToolDetailView().render(WIDTH).map(stripAnsi);
      expect(full.length).toBeGreaterThan(MAX_TOOL_ROWS);
    }
  });

  test("identifies unknown MCP tools by name without promoting args to a target row", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_mcp_path",
      name: "filesystem_get_file_info",
      args: {
        path: "/Users/longyijdos/aiTemp",
      },
    });

    block.updateResult(
      {
        source: "mcp",
        serverId: "filesystem",
        remoteToolName: "get_file_info",
        content: [{ type: "text", text: "not found", truncated: false }],
      },
      true,
    );

    const failedLines = block.render(100).map(stripAnsi);

    expect(failedLines).toContain("◆ Failed to use filesystem_get_file_info");
    expect(failedLines.join("\n")).not.toContain("  └ ");
    expect(block.getToolDetailView().title).toBe("filesystem_get_file_info");

    block.updateResult(
      {
        source: "mcp",
        serverId: "filesystem",
        remoteToolName: "get_file_info",
        content: [{ type: "text", text: "ok", truncated: false }],
      },
      false,
    );

    const doneLines = block.render(100).map(stripAnsi);

    expect(doneLines).toContain("◆ Used filesystem_get_file_info");
    expect(doneLines.join("\n")).not.toContain("  └ ");
    expect(block.getToolDetailView().title).toBe("filesystem_get_file_info");
  });

  test("preserves custom tool identity without promoting command to a target row", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_custom_command",
      name: "custom_build_tool",
      args: {
        command: "make build",
      },
    });

    block.updateResult({ command: "make build", status: "ok" }, true);

    const lines = block.render(100).map(stripAnsi);

    expect(lines).toContain("◆ Failed to use custom_build_tool");
    expect(lines.join("\n")).not.toContain("  └ ");
    expect(block.getToolDetailView().title).toBe("custom_build_tool");
  });

  test("shows the full tool name for unknown tools in every state without a target row", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_unknown",
      name: "mcp__server__lookup",
      args: { query: "anything" },
    });

    block.markExecutionStarted();
    const running = block.render(80).map(stripAnsi);

    expect(running.some((line) => line.startsWith("◆ Using mcp__server__lookup"))).toBe(true);
    expect(running.join("\n")).not.toContain("  └ ");

    block.updateResult({ ok: true }, false);
    const done = block.render(80).map(stripAnsi);

    expect(done).toContain("◆ Used mcp__server__lookup");
    expect(done.join("\n")).not.toContain("  └ ");

    const failedBlock = new ToolCallBlock({
      type: "tool_call",
      id: "call_unknown_failed",
      name: "mcp__server__lookup",
      args: { query: "anything" },
    });
    failedBlock.updateResult({ error: "boom" }, true);

    const failed = failedBlock.render(80).map(stripAnsi);

    expect(failed).toContain("◆ Failed to use mcp__server__lookup");
    expect(failed.join("\n")).not.toContain("  └ ");
  });

  test("keeps target rows for built-in tools", () => {
    const cases = [
      {
        name: "bash",
        args: { command: "npm test" },
        result: { command: "npm test", exitCode: 0, stdout: "" },
        target: "npm test",
      },
      {
        name: "read",
        args: { path: "src/app.ts" },
        result: { path: "src/app.ts", content: "", startLine: 1, endLine: 1, totalLines: 1 },
        target: "src/app.ts",
      },
      {
        name: "write",
        args: { path: "src/out.ts", content: "" },
        result: { path: "src/out.ts", bytesWritten: 0 },
        target: "src/out.ts",
      },
      {
        name: "edit",
        args: { path: "src/app.ts" },
        result: { path: "src/app.ts", replacements: 1, oldText: "a", newText: "b" },
        target: "src/app.ts",
      },
    ];

    for (const entry of cases) {
      const block = completedBlock(entry.name, entry.args, entry.result);
      const lines = block.render(80).map(stripAnsi);

      expect(lines).toContain(`  └ ${entry.target}`);
    }
  });

  test("keeps approval details complete for oversized commands", () => {
    const command = `python -c '${"print(2);".repeat(20_000)}'`;
    const toolCall: ToolCallContent = {
      type: "tool_call",
      id: "approval-long-command",
      name: "bash",
      args: { command },
    };

    expect((toolCall.args as { command: string }).command).toBe(command);
    expect(formatToolApproval(toolCall).detail).toBe(
      `Command\n  ${command}\n\nWorking directory\n  .\n\nExecution\n  Foreground\n\nTimeout\n  30000 ms`,
    );

    const block = new ToolCallBlock(toolCall);
    block.markExecutionStarted();

    expect(block.render(WIDTH).map(stripAnsi).length).toBe(2);
  });

  test("applies the same single-row target bound to hosted provider tools", () => {
    const block = new HostedToolBlock({
      type: "hosted_tool",
      id: "hosted-long-target",
      name: "provider_".repeat(20_000),
      status: "in_progress",
    });

    const compact = block.render(WIDTH).map(stripAnsi);

    expect(compact.length).toBeLessThanOrEqual(2);
    expect(compact.join("\n")).toContain("...");
    expect(compact.every((line) => visibleWidth(line) <= WIDTH)).toBe(true);
  });
});

function completedBlock(
  name: string,
  args: unknown,
  result: unknown,
  isError = false,
): ToolCallBlock {
  const block = new ToolCallBlock({
    type: "tool_call",
    id: `call-${name}`,
    name,
    args,
  });
  block.updateResult(result, isError);
  return block;
}
