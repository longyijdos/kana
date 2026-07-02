import { describe, expect, test } from "bun:test";
import { isCtrlC, isCtrlO, isEnter, isEscape, isShiftEnter } from "../src/tui/runtime";

describe("tui key parsing", () => {
  test("recognizes Shift+Enter in enhanced keyboard formats", () => {
    expect(isShiftEnter("\x1b[13;2u")).toBe(true);
    expect(isShiftEnter("\x1b[13;2:1u")).toBe(true);
    expect(isShiftEnter("\x1b[27;2;13~")).toBe(true);
    expect(isEnter("\x1b[13;2u")).toBe(false);
  });

  test("recognizes unmodified Enter and Escape in legacy and CSI-u formats", () => {
    expect(isEnter("\r")).toBe(true);
    expect(isEnter("\n")).toBe(true);
    expect(isEnter("\x1b[13u")).toBe(true);
    expect(isEnter("\x1b[13;1u")).toBe(true);

    expect(isEscape("\x1b")).toBe(true);
    expect(isEscape("\x1b[27u")).toBe(true);
    expect(isEscape("\x1b[27;1u")).toBe(true);
  });

  test("recognizes Ctrl shortcuts in legacy and enhanced keyboard formats", () => {
    expect(isCtrlC("\x03")).toBe(true);
    expect(isCtrlC("\x1b[3;5u")).toBe(true);
    expect(isCtrlC("\x1b[99;5u")).toBe(true);

    expect(isCtrlO("\x0f")).toBe(true);
    expect(isCtrlO("\x1b[15;5u")).toBe(true);
    expect(isCtrlO("\x1b[111;5u")).toBe(true);
  });

  test("ignores release events for enhanced key sequences", () => {
    expect(isShiftEnter("\x1b[13;2:3u")).toBe(false);
    expect(isEnter("\x1b[13;1:3u")).toBe(false);
    expect(isCtrlC("\x1b[99;5:3u")).toBe(false);
  });
});
