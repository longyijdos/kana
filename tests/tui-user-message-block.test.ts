import { describe, expect, test } from "bun:test";
import { UserMessageBlock } from "../src/tui/components";
import { stripAnsi, visibleWidth } from "../src/tui/render";
import { tuiTheme } from "../src/tui/theme";

describe("tui user message block", () => {
  test("renders neutral text with an accent prefix on a full-width background", () => {
    const rendered = new UserMessageBlock("hello\nworld").render(20);
    const background = `\x1b[48;2;${tuiTheme.userMessageBackground.join(";")}m`;
    const accent = `\x1b[38;2;${tuiTheme.user.join(";")}m`;
    const text = `\x1b[38;2;${tuiTheme.userMessageText.join(";")}m`;

    expect(rendered.map(stripAnsi)).toEqual(["", "", "> hello", "  world", "", ""]);
    expect(rendered[0]).toBe("");
    expect(rendered.at(-1)).toBe("");
    expect(rendered.slice(1, -1).every((line) => line.includes(background))).toBe(true);
    expect(rendered.slice(1, -1).every((line) => line.includes("\x1b[K"))).toBe(true);
    expect(rendered[2]).toContain(`${accent}> ${text}hello`);
  });

  test("wraps content inside the prefix and right margin", () => {
    const rendered = new UserMessageBlock("abcdef").render(8);

    expect(rendered.map(stripAnsi)).toEqual(["", "", "> abcde", "  f", "", ""]);
    expect(rendered.every((line) => visibleWidth(line) < 8)).toBe(true);
  });
});
