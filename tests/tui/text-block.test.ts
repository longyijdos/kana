import { describe, expect, test } from "bun:test";
import { TextBlock } from "../../src/tui/components";

describe("tui text block", () => {
  test("renders the prefix only on the first line", () => {
    expect(new TextBlock("hello\nworld", { prefix: "> " }).render(20)).toEqual([
      "> hello",
      "world",
    ]);
  });

  test("does not repeat the prefix on wrapped lines", () => {
    expect(new TextBlock("abcdef", { prefix: "> " }).render(5)).toEqual(["> abc", "def"]);
  });

  test("invalidates cached output when text changes", () => {
    const block = new TextBlock("before");

    expect(block.render(20)).toEqual(["before"]);

    block.setText("after");

    expect(block.render(20)).toEqual(["after"]);
  });
});
