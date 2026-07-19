import { describe, expect, test } from "bun:test";
import {
  isCtrlC,
  isCtrlO,
  isDown,
  isEnter,
  isEscape,
  isLeft,
  isPageDown,
  isPageUp,
  isRight,
  isShiftEnter,
  isUp,
} from "../src/tui/runtime";

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

  test("recognizes page navigation keys", () => {
    expect(isPageUp("\x1b[5~")).toBe(true);
    expect(isPageDown("\x1b[6~")).toBe(true);
  });

  test("recognizes cursor key press and repeat events in enhanced keyboard formats", () => {
    expect(isUp("\x1b[A")).toBe(true);
    expect(isDown("\x1b[B")).toBe(true);
    expect(isRight("\x1b[C")).toBe(true);
    expect(isLeft("\x1b[D")).toBe(true);

    expect(isUp("\x1b[1;1:1A")).toBe(true);
    expect(isDown("\x1b[1;1:1B")).toBe(true);
    expect(isRight("\x1b[1;1:1C")).toBe(true);
    expect(isLeft("\x1b[1;1:1D")).toBe(true);

    expect(isUp("\x1b[1;1:2A")).toBe(true);
    expect(isDown("\x1b[1;1:2B")).toBe(true);
    expect(isRight("\x1b[1;1:2C")).toBe(true);
    expect(isLeft("\x1b[1;1:2D")).toBe(true);
  });

  test("ignores release events for enhanced key sequences", () => {
    expect(isShiftEnter("\x1b[13;2:3u")).toBe(false);
    expect(isEnter("\x1b[13;1:3u")).toBe(false);
    expect(isCtrlC("\x1b[99;5:3u")).toBe(false);
    expect(isUp("\x1b[1;1:3A")).toBe(false);
    expect(isDown("\x1b[1;1:3B")).toBe(false);
    expect(isRight("\x1b[1;1:3C")).toBe(false);
    expect(isLeft("\x1b[1;1:3D")).toBe(false);
  });
});
