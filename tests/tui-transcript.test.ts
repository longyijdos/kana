import { describe, expect, test } from "bun:test";
import { AssistantMessageBlock, ToolCallBlock, Transcript } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render/width";
import type { Component } from "../src/tui/runtime/component";

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

    expect(assistant.render(80)[0]).toContain("\x1b[37m");
    expect(tool.render(80)[1]).toContain("\x1b[32m");
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

    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("thinking...");

    block.showThinking(false);

    expect(block.render(80)).toEqual([]);
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
    expect(stripAnsi(block.render(80)[1] ?? "")).toBe("Reading AGENTS.md...");

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
    expect(rendered.some((line) => line.includes("\x1b[48;2;70;24;24"))).toBe(
      true,
    );
    expect(rendered.some((line) => line.includes("\x1b[48;2;18;70;38"))).toBe(
      true,
    );
    expect(
      rendered
        .filter((line) => stripAnsi(line).startsWith("- ") || stripAnsi(line).startsWith("+ "))
        .every((line) => line.includes("\x1b[K")),
    ).toBe(true);
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
});
