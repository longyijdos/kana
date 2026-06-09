import { describe, expect, test } from "bun:test";
import { AssistantMessageBlock, Transcript } from "../src/tui/components";
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
