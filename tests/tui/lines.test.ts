import { describe, expect, test } from "bun:test";
import {
  isLineBreak,
  mapLines,
  normalizeLineEndings,
  splitLines,
  tailLines,
} from "../../src/tui/render";

describe("tui line helpers", () => {
  test("recognizes, normalizes, and splits supported line endings", () => {
    expect(isLineBreak("\n")).toBe(true);
    expect(isLineBreak("\r")).toBe(true);
    expect(isLineBreak("\r\n")).toBe(true);
    expect(isLineBreak("text")).toBe(false);

    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
  });

  test("maps logical lines without discarding empty rows", () => {
    expect(mapLines("first\n\nthird", (line) => `[${line}]`)).toEqual(["[first]", "[]", "[third]"]);
  });

  test("retains the requested tail with a hidden-line summary", () => {
    expect(tailLines("first\nsecond\nthird\n", 2)).toBe("... 1 more lines\nsecond\nthird");
    expect(tailLines("first\nsecond", 3)).toBe("first\nsecond");
  });
});
