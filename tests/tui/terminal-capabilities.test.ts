import { describe, expect, test } from "bun:test";
import { supportsTerminalHyperlinks } from "../../src/tui/runtime";

describe("terminal hyperlink capabilities", () => {
  test("detects terminals with stable hyperlink support markers", () => {
    expect(supportsTerminalHyperlinks({ KITTY_WINDOW_ID: "1" })).toBe(true);
    expect(supportsTerminalHyperlinks({ WT_SESSION: "1" })).toBe(true);
    expect(supportsTerminalHyperlinks({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(supportsTerminalHyperlinks({ TERM: "alacritty" })).toBe(true);
  });

  test("checks versioned terminal support", () => {
    expect(
      supportsTerminalHyperlinks({
        TERM: "xterm-256color",
        TERM_PROGRAM: "iTerm.app",
        TERM_PROGRAM_VERSION: "3.0.9",
      }),
    ).toBe(false);
    expect(
      supportsTerminalHyperlinks({
        TERM: "xterm-256color",
        TERM_PROGRAM: "iTerm.app",
        TERM_PROGRAM_VERSION: "3.1.0",
      }),
    ).toBe(true);
    expect(
      supportsTerminalHyperlinks({
        TERM_PROGRAM: "vscode",
        TERM_PROGRAM_VERSION: "1.71.2",
      }),
    ).toBe(false);
    expect(
      supportsTerminalHyperlinks({
        TERM_PROGRAM: "vscode",
        TERM_PROGRAM_VERSION: "1.72.0",
      }),
    ).toBe(true);
    expect(
      supportsTerminalHyperlinks({
        TERM_PROGRAM: "WezTerm",
        TERM_PROGRAM_VERSION: "20200620-160318-e00b076c",
      }),
    ).toBe(true);
  });

  test("rejects the unsafe VTE release and accepts later versions", () => {
    expect(supportsTerminalHyperlinks({ VTE_VERSION: "5000" })).toBe(false);
    expect(supportsTerminalHyperlinks({ VTE_VERSION: "0.50.0" })).toBe(false);
    expect(supportsTerminalHyperlinks({ VTE_VERSION: "5001" })).toBe(true);
    expect(supportsTerminalHyperlinks({ VTE_VERSION: "0.74.2" })).toBe(true);
  });

  test("falls back for unknown terminals and unnegotiated multiplexers", () => {
    expect(supportsTerminalHyperlinks({ TERM: "xterm-256color" })).toBe(false);
    expect(
      supportsTerminalHyperlinks({
        TERM: "tmux-256color",
        TERM_PROGRAM: "iTerm.app",
        TERM_PROGRAM_VERSION: "3.5.0",
      }),
    ).toBe(false);
    expect(supportsTerminalHyperlinks({ TERM: "dumb", KITTY_WINDOW_ID: "1" })).toBe(false);
  });
});
