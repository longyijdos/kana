import { describe, expect, test } from "bun:test";
import { capitalize, summarizeText } from "../../src/tui/render";

describe("tui text helpers", () => {
  test("summarizeText normalizes whitespace and keeps text within bounds", () => {
    expect(summarizeText("  hello   world \n test  ")).toBe("hello world test");
    expect(summarizeText("short", 10)).toBe("short");
  });

  test("summarizeText truncates text with a single-character ellipsis", () => {
    expect(summarizeText("abcdefghij", 5)).toBe("abcd…");
    expect(summarizeText("abcdefghij", 1)).toBe("…");
    expect(summarizeText("abcdefghij", 10)).toBe("abcdefghij");
  });

  test("summarizeText truncates complex emoji and graphemes without splitting", () => {
    expect(summarizeText("👩‍💻👨‍👩‍👧‍👦hello", 3)).toBe("👩‍💻👨‍👩‍👧‍👦…");
    expect(summarizeText("🇨🇳🇺🇸🇯🇵", 2)).toBe("🇨🇳…");
    expect(summarizeText("👩‍💻a", 1)).toBe("…");
    expect(summarizeText("👩‍💻", 1)).toBe("👩‍💻");
  });

  test("capitalize capitalizes first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
    expect(capitalize("")).toBe("");
  });
});
