import { describe, expect, test } from "bun:test";
import { Editor } from "../src/tui/editor/editor";
import { visibleWidth } from "../src/tui/render/width";
import { CURSOR_MARKER } from "../src/tui/runtime/cursor";
import { extractCursorPosition } from "../src/tui/runtime/tui";

describe("tui cursor positioning", () => {
  test("cursor marker has no visible width", () => {
    expect(visibleWidth(`ab${CURSOR_MARKER}cd`)).toBe(4);
  });

  test("extracts and removes cursor marker", () => {
    const lines = ["header", `ab${CURSOR_MARKER}cd`];

    expect(extractCursorPosition(lines)).toEqual({
      row: 1,
      column: 2,
    });
    expect(lines).toEqual(["header", "abcd"]);
  });

  test("editor renders a cursor marker for empty input", () => {
    const editor = new Editor();
    const lines = editor.render(40);

    expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  });
});
