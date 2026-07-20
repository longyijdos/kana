import { describe, expect, test } from "bun:test";
import { Editor } from "../src/tui/components/editor";
import { stripAnsi, visibleWidth } from "../src/tui/render";
import { CURSOR_MARKER, extractCursorPosition, type Terminal, Tui } from "../src/tui/runtime";

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

  test("uses a rendered cursor marker only while its component is focused", async () => {
    const writes: string[] = [];
    const terminal: Terminal = {
      columns: 40,
      rows: 10,
      start: () => {},
      stop: () => {},
      write: (data) => writes.push(data),
      notify: () => {},
    };
    const tui = new Tui(terminal);
    const component = {
      render: () => [`editor${CURSOR_MARKER}`, "layout tail"],
    };
    tui.addChild(component);

    tui.start();
    await Promise.resolve();

    const output = writes.join("");
    expect(stripAnsi(output)).toContain("editor\r\nlayout tail");
    expect(output).not.toContain("\x1b[1A");

    const writeCount = writes.length;
    tui.setFocus(component);
    tui.requestRender(true);
    await Promise.resolve();

    expect(writes.slice(writeCount).join("")).toContain("\x1b[1A");
  });
});
