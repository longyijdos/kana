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

  test("renders the latest viewport by default", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2", "3", "4", "5"]));

    expect(transcript.renderViewport(80, 3)).toEqual(["3", "4", "5"]);
  });

  test("scrolls through history and clamps to available content", () => {
    const transcript = new Transcript();

    transcript.addChild(new LinesBlock(["1", "2", "3", "4", "5"]));

    expect(transcript.scrollBy(2, 80, 3)).toBe(true);
    expect(transcript.renderViewport(80, 3)).toEqual(["1", "2", "3"]);

    expect(transcript.scrollBy(10, 80, 3)).toBe(false);
    expect(transcript.renderViewport(80, 3)).toEqual(["1", "2", "3"]);

    expect(transcript.scrollBy(-1, 80, 3)).toBe(true);
    expect(transcript.renderViewport(80, 3)).toEqual(["2", "3", "4"]);

    expect(transcript.scrollToBottom()).toBe(true);
    expect(transcript.renderViewport(80, 3)).toEqual(["3", "4", "5"]);
  });

  test("keeps the viewed history stable when new lines append", () => {
    const block = new LinesBlock(["1", "2", "3", "4", "5"]);
    const transcript = new Transcript();

    transcript.addChild(block);
    transcript.renderViewport(80, 3);
    transcript.scrollBy(2, 80, 3);
    expect(transcript.renderViewport(80, 3)).toEqual(["1", "2", "3"]);

    block.lines.push("6", "7");

    expect(transcript.renderViewport(80, 3)).toEqual(["1", "2", "3"]);
  });
});
