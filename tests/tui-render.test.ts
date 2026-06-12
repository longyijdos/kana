import { describe, expect, test } from "bun:test";
import type { Component } from "../src/tui/runtime";
import { CURSOR_MARKER } from "../src/tui/runtime";
import type { Terminal } from "../src/tui/runtime";
import { Tui } from "../src/tui/runtime";

class FakeTerminal implements Terminal {
  writes: string[] = [];
  input?: (data: string) => void;
  resize?: () => void;
  stopped = false;
  columns = 80;
  rows = 24;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resize = onResize;
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
  }

  write(data: string): void {
    this.writes.push(data);
  }
}

class MutableLines implements Component {
  constructor(readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tui main-screen renderer", () => {
  test("initial render clears scrollback and writes content without alternate screen", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);

    tui.addChild(new MutableLines(["one", "two"]));
    tui.start();
    await Promise.resolve();

    const output = terminal.writes.join("");

    expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
    expect(output).toContain("one\x1b[0m\r\ntwo\x1b[0m");
    expect(output).not.toContain("\x1b[?1049h");
    expect(output).not.toContain("\x1b[?1049l");
  });

  test("append render writes only the new bottom line", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines(["one"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeAppend = terminal.writes.length;
    lines.lines.push("two");
    tui.requestRender();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const output = terminal.writes.slice(writesBeforeAppend).join("");

    expect(output).toContain("\r\n\x1b[2Ktwo\x1b[0m");
    expect(output).not.toContain("\x1b[2J");
  });

  test("can insert a child after an existing child", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const first = new MutableLines(["first"]);
    const second = new MutableLines(["second"]);
    const inserted = new MutableLines(["inserted"]);

    tui.addChild(first);
    tui.addChild(second);
    tui.insertChildAfter(first, inserted);
    tui.start();
    await Promise.resolve();

    const output = terminal.writes.join("");

    expect(output).toContain("first\x1b[0m\r\ninserted\x1b[0m\r\nsecond\x1b[0m");
  });

  test("forced render clears the current screen", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines(["one", "two"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeClear = terminal.writes.length;
    lines.lines.splice(1);
    tui.requestRender(true);
    await Promise.resolve();

    const output = terminal.writes.slice(writesBeforeClear).join("");

    expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
    expect(output).toContain("one\x1b[0m");
  });

  test("resize clears scrollback before replaying the rendered buffer", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 3;
    const tui = new Tui(terminal);

    tui.addChild(new MutableLines(["line 1", "line 2", "line 3", "line 4", "line 5"]));
    tui.start();
    await Promise.resolve();

    const writesBeforeResize = terminal.writes.length;
    terminal.columns = 100;
    terminal.resize?.();
    await Promise.resolve();

    const output = terminal.writes.slice(writesBeforeResize).join("");

    expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
    expect(output).toContain("line 1\x1b[0m");
    expect(output).toContain("line 2\x1b[0m");
    expect(output).toContain("line 3\x1b[0m");
    expect(output).toContain("line 4\x1b[0m");
    expect(output).toContain("line 5\x1b[0m");
  });

  test("stop clears scrollback and writes a goodbye message", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);

    tui.addChild(new MutableLines(["one"]));
    tui.start();
    await Promise.resolve();

    const writesBeforeStop = terminal.writes.length;
    tui.stop();

    const output = terminal.writes.slice(writesBeforeStop).join("");

    expect(terminal.stopped).toBe(true);
    expect(output).toBe("\x1b[2J\x1b[H\x1b[3JGoodbye from Kana.\r\n");
  });

  test("stop can write a custom exit message", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);

    tui.start();
    await Promise.resolve();

    const writesBeforeStop = terminal.writes.length;
    tui.stop("Resume this session with: kana resume session-1");

    const output = terminal.writes.slice(writesBeforeStop).join("");

    expect(output).toBe(
      "\x1b[2J\x1b[H\x1b[3JResume this session with: kana resume session-1\r\n",
    );
  });

  test("positions and shows the hardware cursor", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);

    tui.addChild(new MutableLines([`ab${CURSOR_MARKER}cd`]));
    tui.start();
    await Promise.resolve();

    const output = terminal.writes.join("");

    expect(output).toContain("\x1b[3G\x1b[?25h");
  });
});
