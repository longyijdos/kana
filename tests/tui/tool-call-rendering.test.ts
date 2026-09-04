import { describe, expect, test } from "bun:test";
import { ToolCallBlock } from "../../src/tui/components";
import { color, stripAnsi, visibleWidth } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";
import { preloadSyntaxHighlighter } from "../../src/tui/utils/syntax-highlighter";

describe("tool call rendering", () => {
  test("renders read tool output as file metadata only", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "read",
      args: {
        path: "AGENTS.md",
      },
    });

    block.markExecutionStarted();
    const runningTitle = block.render(80)[0] ?? "";

    expect(stripAnsi(runningTitle)).toBe("◆ Reading (0s) (Esc to abort)");
    expect(runningTitle).toContain("\x1b[1m");
    expect(runningTitle).toContain(color(" (Esc to abort)", tuiTheme.shortcutHint));

    block.updateResult(
      {
        path: "AGENTS.md",
        content: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
        startLine: 1,
        endLine: 10,
        totalLines: 10,
        truncated: false,
      },
      false,
    );

    const completed = block.render(80);
    const lines = completed.map(stripAnsi);

    expect(lines[0]).toBe("◆ Read");
    expect(completed[0]).toContain(color("◆ Read", tuiTheme.toolSuccess));
    expect(lines[1]).toBe("  └ AGENTS.md");
    expect(lines).toContain("AGENTS.md:1-10 of 10");
    expect(lines).not.toContain("line 10");
  });

  test("renders view_image with dedicated visual metadata instead of generic JSON", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_view",
      name: "view_image",
      args: { path: "artifacts/screenshot.png" },
    });

    block.markExecutionStarted();
    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("◆ Viewing (0s) (Esc to abort)");

    block.updateResult(
      {
        path: "artifacts/screenshot.png",
        mimeType: "image/png",
        width: 1440,
        height: 832,
        byteSize: 19 * 1024,
      },
      false,
    );

    const lines = block.render(80).map(stripAnsi);
    expect(lines[0]).toBe("◆ Viewed");
    expect(lines[1]).toBe("  └ artifacts/screenshot.png");
    expect(lines).toContain("PNG · 1440×832 · 19 KB");
    expect(lines.join("\n")).not.toContain('"mimeType"');
    expect(block.hasExpandableOutput()).toBe(false);
  });

  test("renders list tool output as directory metadata", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_list",
      name: "list",
      args: {
        path: ".",
      },
    });

    block.updateResult(
      {
        path: ".",
        entries: [
          { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: 100 },
          { name: "src", path: "src", type: "directory", size: 128 },
        ],
        totalEntries: 2,
        truncated: false,
      },
      false,
    );

    const lines = block.render(80).map(stripAnsi);

    expect(lines[0]).toBe("◆ Listed");
    expect(lines[1]).toBe("  └ .");
    expect(lines).toContain(".: 2 of 2 entries");
    expect(lines.join("\n")).not.toContain('"entries"');
  });

  test("renders glob tool output as match metadata", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_glob",
      name: "glob",
      args: {
        pattern: "**/*.ts",
      },
    });

    block.updateResult(
      {
        cwd: ".",
        pattern: "**/*.ts",
        type: "file",
        matches: [{ path: "src/main.ts", type: "file", size: 100 }],
        totalMatches: 2,
        truncated: true,
      },
      false,
    );

    const lines = block.render(80).map(stripAnsi);

    expect(lines[0]).toBe("◆ Matched");
    expect(lines[1]).toBe("  └ **/*.ts");
    expect(lines).toContain("**/*.ts: 1 of 2 matches (truncated)");
    expect(lines.join("\n")).not.toContain('"matches"');
  });

  test("renders grep tool output as match metadata", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_grep",
      name: "grep",
      args: {
        pattern: "autocompact|\\.compact\\b",
        path: "src/query.ts",
      },
    });

    block.updateResult(
      {
        path: "src/query.ts",
        pattern: "autocompact|\\.compact\\b",
        literal: false,
        caseSensitive: true,
        include: undefined,
        matches: [
          {
            path: "src/query.ts",
            line: 1,
            column: 7,
            text: "const autocompact = true;",
          },
        ],
        filesSearched: 1,
        truncated: false,
      },
      false,
    );

    const lines = block.render(80).map(stripAnsi);

    expect(lines[0]).toBe("◆ Searched");
    expect(lines[1]).toBe("  └ autocompact|\\.compact\\b");
    expect(lines).toContain("src/query.ts: 1 matches in 1 files for autocompact|\\.compact\\b");
    expect(lines.join("\n")).not.toContain('"matches"');
  });

  test("distinguishes write overwrite transcript titles from new file writes", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "write",
      args: {
        path: "notes.txt",
        content: "replacement",
        overwrite: true,
      },
    });

    block.markExecutionStarted();
    const runningRendered = block.render(80);
    const runningLines = runningRendered.map(stripAnsi);

    expect(runningLines[0]).toBe("◆ Creating (0s) [OVERWRITE] (Esc to abort)");
    expect(runningLines[1]).toBe("  └ notes.txt");
    expect(runningRendered[0]).toContain(color("[OVERWRITE]", tuiTheme.error));

    block.updateResult({ path: "notes.txt", bytesWritten: 11 }, false);
    const doneRendered = block.render(80);
    const doneLines = doneRendered.map(stripAnsi);

    expect(doneLines[0]).toBe("◆ Created [OVERWRITE]");
    expect(doneLines[1]).toBe("  └ notes.txt");
    expect(doneRendered[0]).toContain(color("[OVERWRITE]", tuiTheme.error));
  });

  test("marks background Bash prominently in running and completed transcript titles", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_background",
      name: "bash",
      args: {
        command: "bun run dev",
        background: true,
      },
    });

    block.markExecutionStarted();
    const runningRendered = block.render(80);
    expect(runningRendered.map(stripAnsi)[0]).toBe("◆ Running (0s) [BACKGROUND] (Esc to abort)");
    expect(runningRendered[0]).toContain(color("[BACKGROUND]", tuiTheme.usageWarning));

    block.updateResult(
      {
        command: "bun run dev",
        background: true,
        jobId: "job_12345678",
        status: "running",
        stdout: "",
        stderr: "",
      },
      false,
    );
    const doneRendered = block.render(80);
    expect(doneRendered.map(stripAnsi).slice(0, 2)).toEqual([
      "◆ Ran [BACKGROUND]",
      "  └ bun run dev",
    ]);
    expect(doneRendered[0]).toContain(color("[BACKGROUND]", tuiTheme.usageWarning));
  });

  test("sanitizes terminal control sequences from tool output", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: {
        command: "printf unsafe",
      },
    });

    block.updateResult(
      {
        command: "printf unsafe",
        exitCode: 0,
        stdout: "before \x1b[31mred\x1b[0m\x1b[2J\x1b[3J after\rhidden\u0007",
      },
      false,
    );

    const compact = block.render(80).join("\n");
    const full = block.getToolDetailView().render(80).join("\n");

    expect(compact).not.toContain("\x1b[31m");
    expect(compact).not.toContain("\x1b[2J");
    expect(compact).not.toContain("\x1b[3J");
    expect(compact).not.toContain("\r");
    expect(compact).not.toContain("\u0007");
    expect(stripAnsi(compact)).toContain("before red afterhidden");
    expect(full).not.toContain("\x1b[2J");
    expect(full).not.toContain("\x1b[3J");
  });

  test("sanitizes terminal control sequences in a bash command target row", () => {
    const command = `echo safe\u001b[31mred\u001b[0m\u001b]0;owned\u0007tail`;
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: { command },
    });
    block.updateResult({ command, exitCode: 0, stdout: "ok" }, false);

    const rendered = block.render(80);
    const raw = rendered.join("\n");

    // Assert on raw rows: the attack sequences must never reach the terminal.
    expect(raw).not.toContain("\u001b[31m");
    expect(raw).not.toContain("\u001b]0;");
    expect(raw).not.toContain("\u0007");
    expect(raw).not.toContain("owned");
    // The sanitized plain text stays visible on the single target row.
    expect(rendered.map(stripAnsi)).toContain("  └ echo saferedtail");
    expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  test("sanitizes terminal control sequences in read/write/edit path target rows", () => {
    const cases = [
      {
        name: "read",
        args: { path: `src/\u001b[31mx\u001b[0m.ts` },
        result: {
          path: `src/\u001b[31mx\u001b[0m.ts`,
          content: "",
          startLine: 1,
          endLine: 1,
          totalLines: 1,
        },
        target: "src/x.ts",
      },
      {
        name: "write",
        args: { path: `src/y\u001b]0;w\u0007.ts`, content: "" },
        result: { path: `src/y\u001b]0;w\u0007.ts`, bytesWritten: 0 },
        target: "src/y.ts",
      },
      {
        name: "edit",
        args: { path: `src/z\u001b]0;z\u0007.ts` },
        result: { path: `src/z\u001b]0;z\u0007.ts`, replacements: 1, oldText: "a", newText: "b" },
        target: "src/z.ts",
      },
    ];

    for (const entry of cases) {
      const block = new ToolCallBlock({
        type: "tool_call",
        id: `call-${entry.name}`,
        name: entry.name,
        args: entry.args,
      });
      block.updateResult(entry.result, false);

      const rendered = block.render(80);
      const raw = rendered.join("\n");

      expect(raw).not.toContain("\u001b[31m");
      expect(raw).not.toContain("\u001b]0;");
      expect(raw).not.toContain("\u0007");
      expect(rendered.map(stripAnsi)).toContain(`  └ ${entry.target}`);
      expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
    }
  });

  test("flattens a multiline schedule_wake target and removes control sequences", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_wake",
      name: "schedule_wake",
      args: {
        afterMinutes: 5,
        message: `first\u001b[31mred\u001b[0m\nsecond line\u0007`,
      },
    });
    block.updateResult({ id: "wake_123", dueAt: "2026-08-23T00:00:00.000Z" }, false);

    const rendered = block.render(80);
    const raw = rendered.join("\n");

    expect(raw).not.toContain("\u001b[31m");
    expect(raw).not.toContain("\u0007");
    // The multiline target collapses onto one flattened, width-bounded row.
    const targetRow = rendered.map(stripAnsi).find((line) => line.startsWith("  └ "));
    expect(targetRow).toBe("  └ in 5 minutes firstred second line");
    expect(targetRow).not.toContain("\n");
    expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  test("renders non-zero bash output as a completed command without structured result metadata", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: {
        command: "printf before; printf failure >&2; false",
      },
    });

    block.updateResult(
      {
        command: "printf before; printf failure >&2; false",
        cwd: ".",
        exitCode: 2,
        stdout: "before\n",
        stderr: "failure\n",
        timedOut: false,
      },
      false,
    );

    const lines = block.render(100).map(stripAnsi);
    const output = lines.join("\n");

    expect(lines).toContain("◆ Ran");
    expect(lines).not.toContain("◆ Failed to run");
    expect(lines).toContain("before");
    expect(lines).toContain("failure");
    expect(output).not.toContain("exit 2");
    expect(output).not.toContain("exitCode");
    expect(output).not.toContain("stdout:");
    expect(output).not.toContain("stderr:");
  });

  test("uses known tool renderers for structured failures", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "list",
      args: {
        path: "src",
      },
    });

    block.updateResult(
      {
        path: "src",
        entries: [],
        totalEntries: 0,
        truncated: false,
      },
      true,
    );

    const lines = block.render(100).map(stripAnsi);
    const output = lines.join("\n");

    expect(lines).toContain("◆ Failed to list");
    expect(lines).toContain("src: 0 of 0 entries");
    expect(output).not.toContain('"totalEntries"');
  });

  test("keeps failed MCP tool results on the generic renderer", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_mcp",
      name: "filesystem_read_file",
      args: {
        path: "notes.txt",
      },
    });

    block.updateResult(
      {
        source: "mcp",
        serverId: "filesystem",
        remoteToolName: "read_file",
        content: [
          {
            type: "text",
            text: "permission denied",
            truncated: false,
          },
        ],
        omittedContentItems: 0,
        contentTruncated: false,
      },
      true,
    );

    const output = block.render(100).map(stripAnsi).join("\n");

    expect(output).toContain("◆ Failed to use filesystem_read_file");
    expect(output).toContain('"source": "mcp"');
    expect(output).toContain('"remoteToolName": "read_file"');
    expect(output).toContain('"text": "permission denied"');
  });

  test("renders edit tool results as red and green diff lines", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "edit",
      args: {
        path: "src/app.ts",
      },
    });

    block.updateResult(
      {
        path: "src/app.ts",
        replacements: 1,
        bytesWritten: 42,
        oldText: "old line",
        newText: "new line",
      },
      false,
    );

    const rendered = block.render(80);
    const lines = rendered.map(stripAnsi);
    const trimmedLines = lines.map((line) => line.trimEnd());

    expect(trimmedLines).toContain("- old line");
    expect(trimmedLines).toContain("+ new line");
    expect(rendered.some((line) => line.includes("\x1b[48;2;52;33;43"))).toBe(true);
    expect(rendered.some((line) => line.includes("\x1b[48;2;31;44;56"))).toBe(true);
    expect(
      rendered
        .filter((line) => stripAnsi(line).startsWith("- ") || stripAnsi(line).startsWith("+ "))
        .every((line) => line.includes("\x1b[K")),
    ).toBe(true);
  });

  test("highlights write and edit source content using the target path", async () => {
    await preloadSyntaxHighlighter();

    const read = new ToolCallBlock({
      type: "tool_call",
      id: "read_1",
      name: "read",
      args: { path: "src/app.ts" },
    });
    read.updateResult(
      { path: "src/app.ts", content: "const value = 1;", startLine: 1, endLine: 1, totalLines: 1 },
      false,
    );

    const write = new ToolCallBlock({
      type: "tool_call",
      id: "write_1",
      name: "write",
      args: { path: "src/app.ts", content: "const value = 1;" },
    });
    write.updateResult({ path: "src/app.ts", bytesWritten: 16 }, false);

    const edit = new ToolCallBlock({
      type: "tool_call",
      id: "edit_1",
      name: "edit",
      args: { path: "src/app.ts" },
    });
    edit.updateResult(
      {
        path: "src/app.ts",
        replacements: 1,
        oldText: "const old = 1;",
        newText: "const next = 1;",
      },
      false,
    );

    expect(read.render(80).map(stripAnsi)).not.toContain("const value = 1;");

    for (const block of [write, edit]) {
      expect(block.render(80).join("\n")).toContain("\x1b[38;2;");
    }

    expect(
      edit
        .render(80)
        .filter((line) => stripAnsi(line).startsWith("- ") || stripAnsi(line).startsWith("+ "))
        .every((line) => line.endsWith("\x1b[K\x1b[0m")),
    ).toBe(true);
  });

  test("keeps failed multiline bash command titles on one flattened target row", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: {
        command: 'git commit -m "feat: add something\n\nCo-authored-by: Name <email@example.com>"',
      },
    });

    block.updateResult({ error: "Tool call rejected by user." }, true);

    const lines = block.render(120).map(stripAnsi);

    expect(lines.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);
    expect(lines).toContain("◆ Failed to run");
    expect(lines.some((line) => line.startsWith('  └ git commit -m "feat: add something'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('Co-authored-by: Name <email@example.com>"'))).toBe(
      true,
    );
    expect(lines).toContain("Tool call rejected by user.");
  });
});
