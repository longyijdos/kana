import { describe, expect, test } from "bun:test";
import type { Component, Terminal } from "../../src/tui/runtime";
import { CURSOR_MARKER, type TerminalNotification, Tui } from "../../src/tui/runtime";
import { VirtualTerminal } from "./virtual-terminal";

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

  notify(_notification: TerminalNotification): void {}
}

class MutableLines implements Component {
  constructor(readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

class RenderSizeProbe implements Component {
  lastRender?: { width: number; availableHeight?: number };

  render(width: number, availableHeight?: number): string[] {
    this.lastRender = { width, availableHeight };
    return ["probe"];
  }
}

function waitForScheduledRender(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

async function startVirtualRenderer(initialLines: string[], rows: number) {
  const terminal = new VirtualTerminal({ columns: 80, rows });
  const lines = new MutableLines([...initialLines]);
  const tui = new Tui(terminal);

  tui.addChild(lines);
  tui.start();
  await Promise.resolve();

  return { terminal, lines, tui };
}

describe("tui main-screen renderer", () => {
  test("passes terminal dimensions to components as render hints", async () => {
    const terminal = new FakeTerminal();
    terminal.columns = 72;
    terminal.rows = 16;
    const tui = new Tui(terminal);
    const probe = new RenderSizeProbe();

    tui.addChild(probe);
    tui.start();
    await Promise.resolve();

    expect(probe.lastRender).toEqual({ width: 72, availableHeight: 16 });
  });

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
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeAppend).join("");

    expect(output).toContain("\r\n\x1b[2Ktwo\x1b[0m");
    expect(output).not.toContain("\x1b[3J");
  });

  test("reuses unchanged normalized lines at the same terminal width", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines(["中文内容", "unchanged"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const renderNow = (tui as unknown as { renderNow(): void }).renderNow.bind(tui);
    renderNow();

    expect((tui as unknown as { previousRenderedLines: string[] }).previousRenderedLines).toEqual([
      "中文内容",
      "unchanged",
    ]);
    expect((tui as unknown as { previousLines: string[] }).previousLines).toEqual([
      "中文内容\x1b[0m",
      "unchanged\x1b[0m",
    ]);
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

  test("single-line patch redraws only the changed row", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines(["one", "two", "three"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforePatch = terminal.writes.length;
    lines.lines[1] = "changed";
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforePatch).join("");

    expect(output).toContain("changed\x1b[0m");
    expect(output).not.toContain("one\x1b[0m");
    expect(output).not.toContain("three\x1b[0m");
    expect(countOccurrences(output, "\x1b[2K")).toBe(1);
    expect(output).not.toContain("\x1b[3J");
  });

  test("multi-line patch redraws only the first-to-last changed range", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines(["one", "two", "three", "four", "five"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforePatch = terminal.writes.length;
    lines.lines[1] = "changed two";
    lines.lines[3] = "changed four";
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforePatch).join("");

    expect(output).toContain("changed two\x1b[0m");
    expect(output).toContain("three\x1b[0m");
    expect(output).toContain("changed four\x1b[0m");
    expect(output).not.toContain("one\x1b[0m");
    expect(output).not.toContain("five\x1b[0m");
    expect(countOccurrences(output, "\x1b[2K")).toBe(3);
    expect(output).not.toContain("\x1b[3J");
  });

  test("visible tail shrink clears stale rows without clearing scrollback", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines(["one", "two", "three", "four"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeShrink = terminal.writes.length;
    lines.lines.splice(2);
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeShrink).join("");

    expect(countOccurrences(output, "\x1b[2K")).toBe(2);
    expect(output).not.toContain("one\x1b[0m");
    expect(output).not.toContain("two\x1b[0m");
    expect(output).not.toContain("\x1b[3J");
    expect((tui as unknown as { hardwareCursorRow: number }).hardwareCursorRow).toBe(1);
  });

  test("mixed patch and shrink redraws surviving changes before clearing stale rows", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines(["A", "B", "C", "D", "E"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeShrink = terminal.writes.length;
    lines.lines.splice(0, lines.lines.length, "A", "X", "C");
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeShrink).join("");

    expect(output).toContain("X\x1b[0m");
    expect(output).not.toContain("A\x1b[0m");
    expect(output).not.toContain("C\x1b[0m");
    expect(countOccurrences(output, "\x1b[2K")).toBe(3);
    expect(output).not.toContain("\x1b[3J");
  });

  test("content-stable render only updates the hardware cursor", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines([`a${CURSOR_MARKER}bc`]);

    tui.addChild(lines);
    tui.setFocus(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeCursorMove = terminal.writes.length;
    lines.lines[0] = `ab${CURSOR_MARKER}c`;
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeCursorMove).join("");

    expect(output).toContain("\x1b[3G\x1b[?25h");
    expect(output).not.toContain("\x1b[?2026h");
    expect(output).not.toContain("\x1b[2K");
    expect(output).not.toContain("\x1b[3J");
  });

  test("growth past the old viewport bottom uses natural terminal scrolling", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 3;
    const tui = new Tui(terminal);
    const lines = new MutableLines(["one", "two", "three"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeGrowth = terminal.writes.length;
    lines.lines[2] = "changed three";
    lines.lines.push("four", "five");
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeGrowth).join("");

    expect(output).toContain("changed three\x1b[0m");
    expect(output).toContain("\r\n\x1b[2Kfour\x1b[0m");
    expect(output).toContain("\r\n\x1b[2Kfive\x1b[0m");
    expect(output).not.toContain("\x1b[3J");
    expect((tui as unknown as { previousViewportTop: number }).previousViewportTop).toBe(2);
  });

  test("change above the addressable viewport falls back to a full redraw", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 3;
    const tui = new Tui(terminal);
    const lines = new MutableLines(["one", "two", "three", "four", "five"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforePatch = terminal.writes.length;
    lines.lines[0] = "changed one";
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforePatch).join("");

    expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
    expect(output).toContain("changed one\x1b[0m");
  });

  test("clear while all content is visible preserves terminal scrollback", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 6;
    const tui = new Tui(terminal);
    const lines = new MutableLines(["transcript one", "transcript two", "divider", "editor"]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeClear = terminal.writes.length;
    lines.lines.splice(0, lines.lines.length, "divider", "editor");
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeClear).join("");

    expect(output).toContain("divider\x1b[0m");
    expect(output).toContain("editor\x1b[0m");
    expect(output).not.toContain("\x1b[3J");
  });

  test("clear with transcript content in scrollback falls back to a full redraw", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 3;
    const tui = new Tui(terminal);
    const lines = new MutableLines([
      "transcript one",
      "transcript two",
      "transcript three",
      "transcript four",
      "divider",
      "editor",
    ]);

    tui.addChild(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeClear = terminal.writes.length;
    lines.lines.splice(0, lines.lines.length, "divider", "editor");
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeClear).join("");

    expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
    expect(output).toContain("divider\x1b[0m\r\neditor\x1b[0m");
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
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeResize).join("");

    expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
    expect(output).toContain("line 1\x1b[0m");
    expect(output).toContain("line 2\x1b[0m");
    expect(output).toContain("line 3\x1b[0m");
    expect(output).toContain("line 4\x1b[0m");
    expect(output).toContain("line 5\x1b[0m");
  });

  test("height change clears scrollback before replaying the rendered buffer", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 3;
    const tui = new Tui(terminal);

    tui.addChild(new MutableLines(["one", "two", "three", "four"]));
    tui.start();
    await Promise.resolve();

    const writesBeforeResize = terminal.writes.length;
    terminal.rows = 4;
    terminal.resize?.();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeResize).join("");

    expect(output).toContain("\x1b[2J\x1b[H\x1b[3J");
    expect(output).toContain("one\x1b[0m\r\ntwo\x1b[0m\r\nthree\x1b[0m\r\nfour\x1b[0m");
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

    expect(output).toBe("\x1b[2J\x1b[H\x1b[3JResume this session with: kana resume session-1\r\n");
  });

  test("positions and shows the hardware cursor", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines([`ab${CURSOR_MARKER}cd`]);

    tui.addChild(lines);
    tui.setFocus(lines);
    tui.start();
    await Promise.resolve();

    const output = terminal.writes.join("");

    expect(output).toContain("\x1b[3G\x1b[?25h");
  });

  test("keeps the hardware cursor hidden until the final position during repaint", async () => {
    const terminal = new FakeTerminal();
    const tui = new Tui(terminal);
    const lines = new MutableLines([`>${CURSOR_MARKER}`, "status"]);

    tui.addChild(lines);
    tui.setFocus(lines);
    tui.start();
    await Promise.resolve();

    const writesBeforeRepaint = terminal.writes.length;
    lines.lines[0] = `> a${CURSOR_MARKER}`;
    tui.requestRender();
    await waitForScheduledRender();

    const output = terminal.writes.slice(writesBeforeRepaint).join("");
    const cursorShowIndex = output.indexOf("\x1b[?25h");
    const syncEndIndex = output.indexOf("\x1b[?2026l");

    expect(output).toContain("\x1b[?2026h\x1b[?25l");
    expect(output).toContain("> a\x1b[0m");
    expect(output).not.toContain("status\x1b[0m");
    expect(output).toContain("\x1b[4G\x1b[?25h\x1b[?2026l");
    expect(cursorShowIndex).toBeGreaterThan(-1);
    expect(syncEndIndex).toBeGreaterThan(cursorShowIndex);
  });
});

describe("tui main-screen terminal state", () => {
  test("natural growth scrolls viewport rows into scrollback", async () => {
    const { terminal, lines, tui } = await startVirtualRenderer(["one", "two", "three"], 3);

    expect(terminal.screen).toEqual(["one", "two", "three"]);
    expect(terminal.scrollback).toEqual([]);

    lines.lines.push("four", "five");
    tui.requestRender();
    await waitForScheduledRender();

    expect(terminal.screen).toEqual(["three", "four", "five"]);
    expect(terminal.scrollback).toEqual(["one", "two"]);
    expect({ row: terminal.cursorRow, column: terminal.cursorColumn }).toEqual({
      row: 2,
      column: 4,
    });
  });

  test("mixed patch and shrink leaves unchanged rows intact and clears the old tail", async () => {
    const { terminal, lines, tui } = await startVirtualRenderer(["A", "B", "C", "D", "E"], 5);

    lines.lines.splice(0, lines.lines.length, "A", "X", "C");
    tui.requestRender();
    await waitForScheduledRender();

    expect(terminal.screen).toEqual(["A", "X", "C", "", ""]);
    expect(terminal.scrollback).toEqual([]);
    expect({ row: terminal.cursorRow, column: terminal.cursorColumn }).toEqual({
      row: 2,
      column: 0,
    });
  });

  test("growth after a visible shrink preserves the physical viewport mapping", async () => {
    const { terminal, lines, tui } = await startVirtualRenderer(["A", "B", "C", "D", "E"], 4);

    expect(terminal.screen).toEqual(["B", "C", "D", "E"]);
    expect(terminal.scrollback).toEqual(["A"]);

    lines.lines.splice(2);
    tui.requestRender();
    await waitForScheduledRender();

    expect(terminal.screen).toEqual(["B", "", "", ""]);
    expect(terminal.scrollback).toEqual(["A"]);

    lines.lines.push("C", "D", "E", "F");
    tui.requestRender();
    await waitForScheduledRender();

    expect(terminal.screen).toEqual(["C", "D", "E", "F"]);
    expect(terminal.scrollback).toEqual(["A", "B"]);
    expect((tui as unknown as { previousViewportTop: number }).previousViewportTop).toBe(2);
  });

  test("visible clear keeps scrollback while removing stale screen rows", async () => {
    const { terminal, lines, tui } = await startVirtualRenderer(
      ["transcript one", "transcript two", "divider", "editor"],
      6,
    );

    lines.lines.splice(0, lines.lines.length, "divider", "editor");
    tui.requestRender();
    await waitForScheduledRender();

    expect(terminal.screen).toEqual(["divider", "editor", "", "", "", ""]);
    expect(terminal.scrollback).toEqual([]);
  });

  test("clear fallback removes transcript-backed scrollback before replay", async () => {
    const { terminal, lines, tui } = await startVirtualRenderer(
      [
        "transcript one",
        "transcript two",
        "transcript three",
        "transcript four",
        "divider",
        "editor",
      ],
      3,
    );

    expect(terminal.screen).toEqual(["transcript four", "divider", "editor"]);
    expect(terminal.scrollback).toEqual(["transcript one", "transcript two", "transcript three"]);

    lines.lines.splice(0, lines.lines.length, "divider", "editor");
    tui.requestRender();
    await waitForScheduledRender();

    expect(terminal.screen).toEqual(["divider", "editor", ""]);
    expect(terminal.scrollback).toEqual([]);
  });
});
