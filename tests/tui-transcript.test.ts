import { describe, expect, test } from "bun:test";
import {
  AssistantMessageBlock,
  ContentViewer,
  ToolCallBlock,
  Transcript,
} from "../src/tui/components";
import { color, stripAnsi, visibleWidth } from "../src/tui/render";
import type { Component } from "../src/tui/runtime";
import { tuiTheme } from "../src/tui/theme";

class LinesBlock implements Component {
  constructor(readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
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
    const toolTitle = tool.render(80)[1] ?? "";

    expect(assistantLine).toContain(color("hello", tuiTheme.markdownText));
    expect(toolTitle).toContain(color(stripAnsi(toolTitle), tuiTheme.toolSuccess));
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

    expect(rendered).toEqual(["Saved global memory"]);
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

    expect(stripAnsi(thinkingLine)).toBe("thinking (Esc to abort)");
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

  test("renders read tool output as a concise file excerpt", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "read",
      args: {
        path: "AGENTS.md",
      },
    });

    block.markExecutionStarted();
    const runningTitle = block.render(80)[1] ?? "";

    expect(stripAnsi(runningTitle)).toBe("Reading AGENTS.md... (Esc to abort)");
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

    expect(lines[1]).toBe("Read AGENTS.md");
    expect(lines).toContain("... 2 more lines");
    expect(lines).toContain("line 10");
  });

  test("provides full tool output for the result viewer", () => {
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

    const compactLines = block.render(80).map(stripAnsi);
    const fullLines = block.getResultView()?.render(80).map(stripAnsi) ?? [];

    expect(compactLines).toContain("... 2 more lines");
    expect(fullLines).not.toContain("... 2 more lines");
    expect(fullLines).toContain("line 1");
    expect(fullLines).toContain("line 10");
  });

  test("tool result viewer scrolls full output and closes with escape", () => {
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

    const scrolled = viewer.render(80).map(stripAnsi);

    expect(scrolled).toContain("Lines 3-5 of 5");
    expect(scrolled).toContain("... 2 lines above");
    expect(scrolled.some((line) => line.includes("line 5"))).toBe(true);

    viewer.handleInput("\x1b");

    expect(decisions).toEqual(["close"]);
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

    expect(partialRendered).toContain("Running bun test... (Esc to abort)");
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
    expect(lines).toContain('Failed to run git commit -m "feat: add something');
    expect(lines).toContain('Co-authored-by: Name <email@example.com>"');
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

    expect(runningLines.join("")).toContain(`Running ${command}... (Esc to abort)`);
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

    expect(completedLines.join("")).toContain(`Ran ${command}`);
    expect(completedLines.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  test("renders every transcript line for terminal scrollback", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2", "3", "4", "5"]));

    expect(transcript.render(80)).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("appends new child output in render order", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2"]));
    transcript.addChild(new LinesBlock(["3"]));

    expect(transcript.render(80)).toEqual(["1", "2", "3"]);
  });

  test("clear removes transcript children", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2"]));
    transcript.clear();

    expect(transcript.render(80)).toEqual([]);
  });

  test("shows the output hint only on the latest inspectable tool", () => {
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

    expect(lines).toContain("Ran first");
    expect(lines).not.toContain("Ran first (Ctrl+O to expand)");
    expect(lines).toContain("Ran second (Ctrl+O to expand)");
  });

  test("moves the output hint back when newer tools are not expandable", () => {
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
        stdout: "short output",
      },
      false,
    );
    transcript.addChild(first);
    transcript.addChild(second);

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).not.toContain("Ran first");
    expect(lines).toContain("Ran first (Ctrl+O to expand)");
    expect(lines).toContain("Ran second");
    expect(lines).not.toContain("Ran second (Ctrl+O to expand)");
  });

  test("does not show the output hint when the latest tool output is already visible", () => {
    const transcript = new Transcript();
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_1",
      name: "bash",
      args: {
        command: "short",
      },
    });

    block.updateResult(
      {
        command: "short",
        exitCode: 0,
        stdout: "short output",
      },
      false,
    );
    transcript.addChild(block);

    const lines = transcript.render(100).map(stripAnsi);

    expect(lines).toContain("Ran short");
    expect(lines).not.toContain("Ran short (Ctrl+O to expand)");
  });
});
