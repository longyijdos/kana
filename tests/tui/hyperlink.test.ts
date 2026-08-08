import { describe, expect, test } from "bun:test";
import {
  CLOSE_TERMINAL_HYPERLINK,
  sanitizeTerminalHyperlinkDestination,
  stripAnsi,
  terminalHyperlink,
  visibleWidth,
} from "../../src/tui/render";

describe("terminal hyperlinks", () => {
  test("encodes safe OSC 8 hyperlinks without visible width", () => {
    const rendered = terminalHyperlink("OpenAI", "https://example.com/路径");

    expect(rendered).toBe(
      `\x1b]8;;https://example.com/%E8%B7%AF%E5%BE%84\x1b\\OpenAI${CLOSE_TERMINAL_HYPERLINK}`,
    );
    expect(stripAnsi(rendered)).toBe("OpenAI");
    expect(visibleWidth(rendered)).toBe(6);
  });

  test("allows only explicit safe destination schemes", () => {
    expect(sanitizeTerminalHyperlinkDestination("https://example.com")).toBe(
      "https://example.com/",
    );
    expect(sanitizeTerminalHyperlinkDestination("http://example.com")).toBe("http://example.com/");
    expect(sanitizeTerminalHyperlinkDestination("mailto:test@example.com")).toBe(
      "mailto:test@example.com",
    );
    expect(sanitizeTerminalHyperlinkDestination("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeTerminalHyperlinkDestination("data:text/plain,hello")).toBeUndefined();
    expect(sanitizeTerminalHyperlinkDestination("file:///tmp/kana")).toBeUndefined();
    expect(sanitizeTerminalHyperlinkDestination("../relative")).toBeUndefined();
  });

  test("rejects whitespace and terminal-control injection", () => {
    expect(sanitizeTerminalHyperlinkDestination("https://example.com/a b")).toBeUndefined();
    expect(
      sanitizeTerminalHyperlinkDestination("https://example.com/\x1b]8;;javascript:bad\x1b\\"),
    ).toBeUndefined();
    expect(terminalHyperlink("safe label", "javascript:alert(1)")).toBe("safe label");
  });
});
