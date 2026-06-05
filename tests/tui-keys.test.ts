import { describe, expect, test } from "bun:test";
import { getMouseWheelDelta } from "../src/tui/runtime/keys";

describe("tui keys", () => {
  test("parses SGR mouse wheel events", () => {
    expect(getMouseWheelDelta("\x1b[<64;10;20M")).toBe(1);
    expect(getMouseWheelDelta("\x1b[<65;10;20M")).toBe(-1);
    expect(getMouseWheelDelta("\x1b[<64;10;20M\x1b[<65;10;20M")).toBe(0);
  });

  test("ignores non-wheel mouse events", () => {
    expect(getMouseWheelDelta("\x1b[<0;10;20M")).toBe(0);
    expect(getMouseWheelDelta("\x1b[<64;10;20m")).toBe(0);
  });
});
