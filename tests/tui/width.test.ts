import { describe, expect, test } from "bun:test";
import {
  CLOSE_TERMINAL_HYPERLINK,
  color,
  stripAnsi,
  terminalHyperlink,
  truncateToWidth,
  visibleWidth,
} from "../../src/tui/render";

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
