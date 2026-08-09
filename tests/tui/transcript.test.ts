import { describe, expect, test } from "bun:test";
import {
  AssistantMessageBlock,
  ContentViewer,
  HostedToolBlock,
  ToolCallBlock,
  Transcript,
} from "../../src/tui/components";
import { color, stripAnsi, visibleWidth } from "../../src/tui/render";
import type { Component } from "../../src/tui/runtime";
import { tuiTheme } from "../../src/tui/theme";
import { preloadSyntaxHighlighter } from "../../src/tui/utils/syntax-highlighter";

class LinesBlock implements Component {
  constructor(readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

function completedExplorationTool(name: string, args: unknown, result: unknown): ToolCallBlock {
  const block = new ToolCallBlock({
    type: "tool_call",
    id: name,
    name,
    args,
  });
  block.updateResult(result, false);
  return block;
}

describe("tui transcript", () => {
  test("renders assistant messages without leading blank lines", () => {
    const block = new AssistantMessageBlock();

    block.update({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });

    expect(block.render(80)[0]).toContain("hello");
  });

  test("groups adjacent hosted web actions before following text", () => {
    const block = new AssistantMessageBlock();

    block.update({
      role: "assistant",
      content: [
        {
          type: "hosted_tool",
          id: "web-search-1",
          name: "web_search",
          status: "completed",
          action: {
            type: "search",
            query: "current release",
            queries: ["current release"],
          },
        },
        {
          type: "hosted_tool",
          id: "web-search-2",
          name: "web_search",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://example.com/releases",
          },
        },
        {
          type: "text",
          text: "Final answer with [citation](https://example.com/releases).",
        },
      ],
    });

    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Searched the web",
      "  ├ Search current release",
      "  └ Open example.com/releases",
      "",
      "Final answer with citation (https://example.com/releases).",
    ]);
  });

  test("keeps hosted web actions separate when grouping is disabled", () => {
    const block = new AssistantMessageBlock(Date.now, { groupToolCalls: false });

    block.update({
      role: "assistant",
      content: [
        {
          type: "hosted_tool",
          id: "web-search-1",
          name: "web_search",
          status: "completed",
          action: { type: "search", query: "current release" },
        },
        {
          type: "hosted_tool",
          id: "web-search-2",
          name: "web_search",
          status: "completed",
          action: { type: "open_page", url: "https://example.com/releases" },
        },
      ],
    });

    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Searched the web",
      "  └ current release",
      "",
      "◆ Opened a web page",
      "  └ example.com/releases",
    ]);
  });

  test("uses active and canceled states for hosted web groups", () => {
    let now = 0;
    const block = new AssistantMessageBlock(() => now);
    block.update({
      role: "assistant",
      content: [
        {
          type: "hosted_tool",
          id: "web-search-active",
          name: "web_search",
          status: "in_progress",
          action: { type: "search", query: "Kana" },
        },
      ],
    });

    now = 2_000;
    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Searching the web (2s) (Esc to abort)",
      "  └ Search Kana",
    ]);

    block.update({
      role: "assistant",
      content: [
        {
          type: "hosted_tool",
          id: "web-search-active",
          name: "web_search",
          status: "canceled",
          action: { type: "search", query: "Kana" },
        },
      ],
    });
    expect(block.render(100).map(stripAnsi)).toEqual(["◆ Web search stopped", "  └ Search Kana"]);
  });

  test("keeps a trailing hosted web group active until the response settles", () => {
    let now = 0;
    const block = new AssistantMessageBlock(() => now);
    const firstCompleted = {
      type: "hosted_tool" as const,
      id: "web-search-1",
      name: "web_search",
      status: "completed" as const,
      action: { type: "search", query: "Kana" },
    };

    block.update(
      {
        role: "assistant",
        content: [{ ...firstCompleted, status: "in_progress" }],
      },
      { complete: false },
    );

    now = 1_000;
    block.update(
      {
        role: "assistant",
        content: [firstCompleted],
      },
      { complete: false },
    );
    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Searching the web (1s) (Esc to abort)",
      "  └ Search Kana",
    ]);

    now = 2_000;
    block.update(
      {
        role: "assistant",
        content: [
          firstCompleted,
          {
            type: "hosted_tool",
            id: "web-search-2",
            name: "web_search",
            status: "in_progress",
            action: { type: "open_page", url: "https://example.com/docs" },
          },
        ],
      },
      { complete: false },
    );
    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Searching the web (2s) (Esc to abort)",
      "  ├ Search Kana",
      "  └ Open example.com/docs",
    ]);

    now = 3_000;
    const completedMessage = {
      role: "assistant" as const,
      content: [
        firstCompleted,
        {
          type: "hosted_tool" as const,
          id: "web-search-2",
          name: "web_search",
          status: "completed" as const,
          action: { type: "open_page", url: "https://example.com/docs" },
        },
      ],
    };
    block.update(completedMessage, { complete: false });
    expect(stripAnsi(block.render(100)[0] ?? "")).toBe("◆ Searching the web (3s) (Esc to abort)");

    block.update(completedMessage, { complete: true });
    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Searched the web",
      "  ├ Search Kana",
      "  └ Open example.com/docs",
    ]);
  });

  test("freezes stopped hosted tool activity without an abort hint", () => {
    let now = 0;
    const block = new HostedToolBlock(
      {
        type: "hosted_tool",
        id: "web-search-active",
        name: "web_search",
        status: "in_progress",
      },
      () => now,
    );

    now = 2_000;
    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("◆ Searching the web (2s) (Esc to abort)");

    block.stopTimer();
    now = 7_000;

    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("◆ Searching the web (2s)");
  });

  test("renders canceled hosted tool activity as stopped", () => {
    const block = new HostedToolBlock({
      type: "hosted_tool",
      id: "web-search-canceled",
      name: "web_search",
      status: "canceled",
    });

    const rendered = block.render(80)[0] ?? "";

    expect(stripAnsi(rendered)).toBe("◆ Web search stopped");
    expect(rendered).toContain(color("◆ Web search stopped", tuiTheme.muted));
  });

  test("uses distinct colors for assistant text and completed tool calls", () => {
    const assistant = new AssistantMessageBlock();
    assistant.update({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });

    const tool = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "read",
      args: {
        path: "AGENTS.md",
      },
    });
    tool.updateResult(
      {
        path: "AGENTS.md",
        content: "content",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
      },
      false,
    );

    const assistantLine = assistant.render(80)[0] ?? "";
    const toolTitle = tool.render(80)[0] ?? "";

    expect(assistantLine).toContain(color("hello", tuiTheme.markdownText));
    expect(toolTitle).toContain(color(stripAnsi(toolTitle), tuiTheme.toolSuccess));
  });

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

    expect(rendered).toEqual(["◆ Scheduled wake", "  └ in 30 minutes", "    Check the task."]);
  });

  test("does not render assistant stop reasons as transcript content", () => {
    const block = new AssistantMessageBlock();

    block.update({
      role: "assistant",
      stopReason: "toolUse",
      content: [],
    });

    expect(block.render(80)).toEqual([]);
  });

  test("clears the thinking placeholder when thinking is no longer active", () => {
    const block = new AssistantMessageBlock();

    block.update({
      role: "assistant",
      content: [
        {
          type: "thinking",
          text: "internal reasoning",
        },
      ],
    });
    block.showThinking(true);

    const thinkingLine = block.render(80)[0] ?? "";

    expect(stripAnsi(thinkingLine)).toBe("thinking (0s) (Esc to abort)");
    expect(thinkingLine).toContain(color(" (Esc to abort)", tuiTheme.shortcutHint));

    block.showThinking(false);

    expect(block.render(80)).toEqual([]);
  });

  test("invalidates assistant message cache when content changes", () => {
    const block = new AssistantMessageBlock();

    block.update({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "before",
        },
      ],
    });

    expect(stripAnsi(block.render(80).join("\n"))).toContain("before");

    block.update({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "after",
        },
      ],
    });

    const rendered = stripAnsi(block.render(80).join("\n"));

    expect(rendered).toContain("after");
    expect(rendered).not.toContain("before");
  });

  test("finalizes a streaming table tail when the assistant message ends", () => {
    const block = new AssistantMessageBlock();
    const message = {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: ["| Key | Value |", "| --- | --- |", "| a | b |", "| growing-value | partial"].join(
            "\n",
          ),
        },
      ],
    };

    block.update(message, { complete: false });
    const streamingSeparator = block.render(40).map(stripAnsi)[1] ?? "";

    block.update(message, { complete: true });
    const completeSeparator = block.render(40).map(stripAnsi)[1] ?? "";

    expect(visibleWidth(streamingSeparator)).toBe(14);
    expect(visibleWidth(completeSeparator)).toBeGreaterThan(14);
  });

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

    const lines = block.render(80).map(stripAnsi);

    expect(lines[0]).toBe("◆ Read");
    expect(lines[1]).toBe("  └ AGENTS.md");
    expect(lines).toContain("AGENTS.md:1-10 of 10");
    expect(lines).not.toContain("line 10");
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

  test("does not provide read content in the result viewer", () => {
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

    expect(block.getResultView()).toBeUndefined();
  });

  test("tool result viewer scrolls and pages with arrow keys", () => {
    const decisions: string[] = [];
    const viewer = new ContentViewer(
      {
        title: "Read AGENTS.md",
        render: () => Array.from({ length: 5 }, (_, index) => `line ${index + 1}`),
      },
      {
        onClose: () => {
          decisions.push("close");
        },
        visibleLimit: 3,
      },
    );

    expect(
      viewer
        .render(80)
        .map(stripAnsi)
        .some((line) => line.includes("line 1")),
    ).toBe(true);
    expect(
      viewer
        .render(80)
        .map(stripAnsi)
        .some((line) => line.includes("line 5")),
    ).toBe(false);
    expect(viewer.render(80).map(stripAnsi)).toContain("Lines 1-3 of 5");

    viewer.handleInput("\x1b[B");

    const oneLineDown = viewer.render(80).map(stripAnsi);

    expect(oneLineDown).toContain("Lines 2-4 of 5");
    expect(oneLineDown).toContain("... 1 lines above");

    viewer.handleInput(" ");

    expect(viewer.render(80).map(stripAnsi)).toContain("Lines 2-4 of 5");

    viewer.handleInput("\x1b[C");

    const pagedDown = viewer.render(80).map(stripAnsi);

    expect(pagedDown).toContain("Lines 3-5 of 5");
    expect(pagedDown).toContain("... 2 lines above");
    expect(pagedDown.some((line) => line.includes("line 5"))).toBe(true);

    viewer.handleInput("\x1b[D");

    expect(viewer.render(80).map(stripAnsi)).toContain("Lines 1-3 of 5");

    viewer.handleInput("\x1b");

    expect(decisions).toEqual(["close"]);
  });

  test("tool result viewer shrinks its window for a short available height", () => {
    const viewer = new ContentViewer(
      {
        title: "Command output",
        render: () => [Array.from({ length: 5 }, (_, index) => `line ${index + 1}`).join("\n")],
      },
      {
        onClose: () => {},
      },
    );
    const rendered = viewer.render(80, 8).map(stripAnsi);

    expect(rendered).toContain("Lines 1-3 of 5");
    expect(rendered).toContain("  line 1");
    expect(rendered).toContain("  line 2");
    expect(rendered).toContain("  line 3");
    expect(rendered).not.toContain("  line 4");
    expect(rendered).toContain("... 2 lines below");
  });

  test("tool result viewer renders a multiline title as one truncated line", () => {
    const viewer = new ContentViewer(
      {
        title: "Ran printf table\n| 01 | macOS version | usable |\n| 02 | Shell | zsh |",
        render: () => ["output"],
      },
      { onClose: () => {} },
    );

    const rendered = viewer.render(32, 10);
    const title = stripAnsi(rendered[0] ?? "");

    expect(title.startsWith("Ran printf table | 01")).toBe(true);
    expect(title.endsWith("...")).toBe(true);
    expect(title).not.toContain("\n");
    expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(32);
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
    const full = block.getResultView()?.render(80).join("\n") ?? "";

    expect(compact).not.toContain("\x1b[31m");
    expect(compact).not.toContain("\x1b[2J");
    expect(compact).not.toContain("\x1b[3J");
    expect(compact).not.toContain("\r");
    expect(compact).not.toContain("\u0007");
    expect(stripAnsi(compact)).toContain("before red afterhidden");
    expect(full).not.toContain("\x1b[2J");
    expect(full).not.toContain("\x1b[3J");
  });

  test("renders failed bash output without structured result metadata", () => {
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
        stdoutTruncated: false,
        stderrTruncated: false,
      },
      true,
    );

    const lines = block.render(100).map(stripAnsi);
    const output = lines.join("\n");

    expect(lines).toContain("◆ Failed to run");
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
    expect(rendered.some((line) => line.includes("\x1b[48;2;70;24;24"))).toBe(true);
    expect(rendered.some((line) => line.includes("\x1b[48;2;18;70;38"))).toBe(true);
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

  test("marks oversized edit diff lines as truncated", () => {
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
        oldText: "abcdefghijk",
        newText: "abcdefghijk",
      },
      false,
    );

    expect(block.render(8).map(stripAnsi)).toContain("- abc...");
    expect(block.render(8).map(stripAnsi)).toContain("+ abc...");
  });

  test("renders failed multiline bash command titles as separate logical lines", () => {
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
    expect(lines).toContain('  └ git commit -m "feat: add something');
    expect(lines.some((line) => line.includes('Co-authored-by: Name <email@example.com>"'))).toBe(
      true,
    );
    expect(lines).toContain("Tool call rejected by user.");
  });

  test("wraps long running and completed tool titles instead of truncating them", () => {
    const command = `printf ${Array.from({ length: 8 }, (_, index) => `segment-${index}`).join("-")}`;
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: {
        command,
      },
    });

    block.markExecutionStarted();

    const runningLines = block.render(32).map(stripAnsi);

    expect(runningLines).toContain("◆ Running (0s) (Esc to abort)");
    expect(runningLines.join("\n")).toContain("  └ printf segment-0");
    expect(runningLines.every((line) => visibleWidth(line) <= 32)).toBe(true);

    block.updateResult(
      {
        command,
        exitCode: 0,
        stdout: "",
      },
      false,
    );

    const completedLines = block.render(32).map(stripAnsi);

    expect(completedLines).toContain("◆ Ran");
    expect(completedLines.join("\n")).toContain("  └ printf segment-0");
    expect(completedLines.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  test("renders every transcript line for terminal scrollback", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2", "3", "4", "5"]));

    expect(transcript.render(80)).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("groups adjacent exploration tools and coalesces consecutive reads", () => {
    const transcript = new Transcript();
    const list = completedExplorationTool("list", { path: "src" }, { path: "src" });
    const readFirst = completedExplorationTool(
      "read",
      { path: "src/app.ts" },
      { path: "src/app.ts" },
    );
    const readDuplicate = completedExplorationTool(
      "read",
      { path: "src/app.ts" },
      { path: "src/app.ts" },
    );
    const readSecond = completedExplorationTool(
      "read",
      { path: "src/config.ts" },
      { path: "src/config.ts" },
    );
    const glob = completedExplorationTool(
      "glob",
      { pattern: "*.ts", cwd: "src" },
      { pattern: "*.ts", cwd: "src" },
    );

    transcript.addChild(list);
    transcript.addChild(new LinesBlock([]));
    transcript.addChild(readFirst);
    transcript.addChild(readDuplicate);
    transcript.addChild(readSecond);
    transcript.addChild(glob);

    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Explored",
      "  ├ List src",
      "  ├ Read src/app.ts, src/config.ts",
      "  └ Search “*.ts” in src",
    ]);
  });

  test("starts a new exploration group for each model tool-call batch", () => {
    let now = 0;
    const transcript = new Transcript();
    const firstBatch = new AssistantMessageBlock();
    firstBatch.update({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "first-read",
          name: "read",
          args: { path: "first.ts" },
        },
      ],
    });
    const firstRead = completedExplorationTool("read", { path: "first.ts" }, { path: "first.ts" });
    const secondBatch = new AssistantMessageBlock();
    secondBatch.update({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "second-read",
          name: "read",
          args: { path: "second.ts" },
        },
      ],
    });
    const secondRead = new ToolCallBlock(
      {
        type: "tool_call",
        id: "second-read",
        name: "read",
        args: { path: "second.ts" },
      },
      () => now,
    );
    secondRead.markExecutionStarted();

    transcript.addChild(firstBatch);
    transcript.addChild(firstRead);
    transcript.addChild(secondBatch);
    transcript.addChild(secondRead);

    now = 2_000;
    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Explored",
      "  └ Read first.ts",
      "",
      "◆ Exploring (2s) (Esc to abort)",
      "  └ Read second.ts",
    ]);

    secondRead.updateResult({ path: "second.ts" }, false);
    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Explored",
      "  └ Read first.ts",
      "",
      "◆ Explored",
      "  └ Read second.ts",
    ]);
  });

  test("keeps exploration failures as standalone barriers", () => {
    const transcript = new Transcript();
    const first = completedExplorationTool("read", { path: "a.ts" }, { path: "a.ts" });
    const failed = new ToolCallBlock({
      type: "tool_call",
      id: "failed-grep",
      name: "grep",
      args: { pattern: "missing", path: "src" },
    });
    failed.updateResult({ error: "search failed" }, true);
    const last = completedExplorationTool("list", { path: "tests" }, { path: "tests" });

    transcript.addChild(first);
    transcript.addChild(failed);
    transcript.addChild(last);

    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Explored",
      "  └ Read a.ts",
      "",
      "◆ Failed to search",
      "  └ missing",
      "search failed",
      "",
      "◆ Explored",
      "  └ List tests",
    ]);
  });

  test("renders active and canceled exploration groups distinctly", () => {
    let now = 0;
    const transcript = new Transcript();
    const read = new ToolCallBlock(
      {
        type: "tool_call",
        id: "active-read",
        name: "read",
        args: { path: "src/app.ts" },
      },
      () => now,
    );
    read.markExecutionStarted();
    transcript.addChild(read);

    now = 3_000;
    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Exploring (3s) (Esc to abort)",
      "  └ Read src/app.ts",
    ]);

    read.markCanceled();
    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Exploration stopped",
      "  └ Read src/app.ts",
    ]);
  });

  test("renders exploration tools individually when grouping is disabled", () => {
    const transcript = new Transcript({ groupToolCalls: false });
    transcript.addChild(completedExplorationTool("list", { path: "src" }, { path: "src" }));
    transcript.addChild(completedExplorationTool("read", { path: "app.ts" }, { path: "app.ts" }));

    expect(transcript.render(100).map(stripAnsi)).toEqual([
      "◆ Listed",
      "  └ src",
      "src",
      "",
      "◆ Read",
      "  └ app.ts",
      "app.ts",
    ]);
  });

  test("appends new child output in render order", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2"]));
    transcript.addChild(new LinesBlock(["3"]));

    expect(transcript.render(80)).toEqual(["1", "2", "", "3"]);
  });

  test("separates only children that render output", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock([]));
    transcript.addChild(new LinesBlock(["1"]));
    transcript.addChild(new LinesBlock([]));
    transcript.addChild(new LinesBlock(["2"]));
    transcript.addChild(new LinesBlock([]));

    expect(transcript.render(80)).toEqual(["1", "", "2"]);
  });

  test("clear removes transcript children", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2"]));
    transcript.clear();

    expect(transcript.render(80)).toEqual([]);
  });

  test("does not render output shortcut hints in tool titles", () => {
    const transcript = new Transcript();
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
    transcript.addChild(first);
    transcript.addChild(second);

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).toContain("◆ Ran");
    expect(lines).toContain("  └ first");
    expect(lines).toContain("  └ second");
    expect(lines.join("\n")).not.toContain("Ctrl+O");
  });
});
