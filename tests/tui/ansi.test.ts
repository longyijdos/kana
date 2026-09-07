import { afterEach, describe, expect, test } from "bun:test";
import {
  backgroundColor,
  color,
  renderHighlightedLine,
  rgbToXterm256,
  setTerminalColorMode,
} from "../../src/tui/render";

afterEach(() => setTerminalColorMode("truecolor"));

describe("terminal color rendering", () => {
  test("emits truecolor foregrounds and backgrounds", () => {
    setTerminalColorMode("truecolor");

    expect(color("text", [18, 58, 188])).toBe("\x1b[38;2;18;58;188mtext\x1b[0m");
    expect(backgroundColor("  ", [18, 58, 188])).toBe("\x1b[48;2;18;58;188m  \x1b[0m");
  });

  test("converts RGB and highlighted hex colors to xterm-256", () => {
    setTerminalColorMode("ansi256");

    expect(color("red", [255, 0, 0])).toBe("\x1b[38;5;196mred\x1b[0m");
    expect(backgroundColor("  ", [128, 128, 128])).toBe("\x1b[48;5;244m  \x1b[0m");
    expect(renderHighlightedLine([{ text: "red", color: "#ff0000" }])).toBe(
      "\x1b[38;5;196mred\x1b[0m",
    );
  });

  test("uses terminal-default colors in uncolored mode", () => {
    setTerminalColorMode("uncolored");

    expect(color("text", [18, 58, 188])).toBe("text");
    expect(color("error", "red")).toBe("error");
    expect(backgroundColor("background", [18, 58, 188])).toBe("background");
    expect(
      renderHighlightedLine([{ text: "plain", color: "#123abc" }], {
        background: [1, 2, 3],
        clearToEnd: true,
      }),
    ).toBe("plain\x1b[K");
  });

  test("maps saturated colors to the cube and neutral colors to the gray ramp", () => {
    expect(rgbToXterm256([255, 0, 0])).toBe(196);
    expect(rgbToXterm256([0, 255, 0])).toBe(46);
    expect(rgbToXterm256([128, 128, 128])).toBe(244);
  });
});
