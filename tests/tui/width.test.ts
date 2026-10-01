import { describe, expect, test } from "bun:test";
import {
  CLOSE_TERMINAL_HYPERLINK,
  color,
  stripAnsi,
  terminalHyperlink,
  truncateToWidth,
  visibleWidth,
  wrapAnsiText,
} from "../../src/tui/render";

describe("tui width helpers", () => {
  test.each([
    ["abcdef", 4, "abc…"],
    ["abcdef", 2, "a…"],
    ["abcdef", 1, "…"],
    ["abcdef", 0, ""],
    ["abcdef", -1, ""],
    ["abcdef", 6, "abcdef"],
    ["你好abcdef", 4, "你…"],
    ["👩‍💻abcdef", 3, "👩‍💻…"],
  ])("truncates %s to width %i with the default ellipsis", (value, width, expected) => {
    expect(truncateToWidth(value, width)).toBe(expected);
  });

  test("preserves ansi styling and wide characters with the default ellipsis", () => {
    const rendered = truncateToWidth(color("目前src", [238, 238, 238]), 6);

    expect(stripAnsi(rendered)).toBe("目前s…");
    expect(visibleWidth(rendered)).toBe(6);
    expect(rendered).toContain("\x1b[38;2;238;238;238m");
    expect(rendered.endsWith("\x1b[0m")).toBe(true);
  });

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

  test("ignores OSC strings when calculating visible width", () => {
    const rendered = terminalHyperlink("OpenAI", "https://example.com");

    expect(stripAnsi(rendered)).toBe("OpenAI");
    expect(visibleWidth(rendered)).toBe(6);
  });

  test("closes an active hyperlink before a truncation suffix", () => {
    const rendered = truncateToWidth(terminalHyperlink("abcdef", "https://example.com"), 4, "..");

    expect(stripAnsi(rendered)).toBe("ab..");
    expect(visibleWidth(rendered)).toBe(4);
    expect(rendered).toContain(`ab${CLOSE_TERMINAL_HYPERLINK}..`);
    expect(rendered.endsWith("\x1b[0m")).toBe(true);
  });
});

describe("ANSI text wrapping", () => {
  test.each([
    ["abcdef", 2, ["ab", "cd", "ef"]],
    ["abcdef", 6, ["abcdef"]],
    ["", 4, [""]],
    ["ab\r\n\r\ncd\r", 2, ["ab", "", "cd", ""]],
    ["a\tb", 3, ["a  ", " b"]],
    ["你👩‍💻é好", 4, ["你👩‍💻", "é好"]],
  ])("wraps %s to width %i without losing graphemes", (value, width, expected) => {
    expect(wrapAnsiText(value, width)).toEqual(expected);
  });

  test("closes and restores colors and hyperlinks across wrapped and explicit lines", () => {
    const destination = "https://example.com/a-long-destination";
    const tone = [238, 238, 238] as const;
    const rendered = wrapAnsiText(color(terminalHyperlink("abcd\nef", destination), tone), 2);

    expect(rendered).toEqual(
      ["ab", "cd", "ef"].map((line) => color(terminalHyperlink(line, destination), tone)),
    );
    expect(rendered.every((line) => visibleWidth(line) === 2)).toBe(true);
  });

  test("preserves partial style resets and stops restoring styles after a full reset", () => {
    const rendered = wrapAnsiText("\x1b[31mab\x1b[39mcd\x1b[0mef", 2);

    expect(rendered.map(stripAnsi)).toEqual(["ab", "cd", "ef"]);
    expect(rendered[0]).toContain("\x1b[31mab");
    expect(rendered[1]).toContain("\x1b[39mcd");
    expect(rendered[2]).toBe("ef");
  });

  test("preserves combining marks immediately after an ANSI sequence", () => {
    const rendered = wrapAnsiText("e\x1b[0m\u0301x", 1);

    expect(rendered.map(stripAnsi)).toEqual(["é", "x"]);
  });

  test("closes unfinished styles and hyperlinks at the last row", () => {
    const rendered = wrapAnsiText("\x1b]8;;https://example.com\x07\x1b[31mabcd", 2);

    expect(rendered.map(stripAnsi)).toEqual(["ab", "cd"]);
    expect(rendered.every((line) => line.endsWith(`${CLOSE_TERMINAL_HYPERLINK}\x1b[0m`))).toBe(
      true,
    );
    expect(rendered[1]).toContain("\x1b]8;;https://example.com\x07");
  });
});
