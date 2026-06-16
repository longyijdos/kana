import { describe, expect, test } from "bun:test";
import { color, stripAnsi, truncateToWidth, visibleWidth } from "../src/tui/render";

describe("tui width helpers", () => {
  test("preserves ansi styling when truncating colored text", () => {
    const rendered = truncateToWidth(color("abcdef", [238, 238, 238]), 3, "");

    expect(stripAnsi(rendered)).toBe("abc");
    expect(visibleWidth(rendered)).toBe(3);
    expect(rendered).toContain("\x1b[38;2;238;238;238m");
    expect(rendered.endsWith("\x1b[0m")).toBe(true);
  });

  test("preserves ansi styling when truncating wide characters", () => {
    const rendered = truncateToWidth(color("目前src", [238, 238, 238]), 6, "");

    expect(stripAnsi(rendered)).toBe("目前sr");
    expect(visibleWidth(rendered)).toBe(6);
    expect(rendered).toContain("\x1b[38;2;238;238;238m");
    expect(rendered.endsWith("\x1b[0m")).toBe(true);
  });
});
