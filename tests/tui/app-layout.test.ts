import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { stripAnsi } from "../../src/tui/render";
import type { Component } from "../../src/tui/runtime";

const DIVIDER = "─".repeat(80);

class LinesComponent implements Component {
  lastAvailableHeight?: number;

  constructor(private readonly lines: string[]) {}

  render(_width: number, availableHeight?: number): string[] {
    this.lastAvailableHeight = availableHeight;
    return this.lines;
  }
}

describe("tui app layout", () => {
  test("renders the main region with exactly one bottom component", () => {
    const main = new LinesComponent(["transcript"]);
    const editor = new LinesComponent(["editor", "status"]);
    const layout = new AppLayout({
      main,
      bottom: editor,
    });

    expect(layout.render(80).map(stripAnsi)).toEqual([
      "transcript",
      DIVIDER,
      "editor",
      "status",
      ...Array.from({ length: 12 }, () => ""),
    ]);

    const viewerMain = new LinesComponent(["viewer main"]);
    const viewer = new LinesComponent(["tool viewer"]);

    layout.showMain(viewerMain);
    layout.showBottom(viewer);

    expect(layout.render(80).map(stripAnsi)).toEqual([
      "viewer main",
      DIVIDER,
      "tool viewer",
      ...Array.from({ length: 13 }, () => ""),
    ]);
    expect(layout.isMain(viewerMain)).toBe(true);
    expect(layout.isMain(main)).toBe(false);
    expect(layout.isBottom(viewer)).toBe(true);
    expect(layout.isBottom(editor)).toBe(false);

    layout.showMain(main);
    layout.showBottom(editor);

    expect(layout.render(80).map(stripAnsi)).toEqual([
      "transcript",
      DIVIDER,
      "editor",
      "status",
      ...Array.from({ length: 12 }, () => ""),
    ]);
  });

  test("selects a bottom height tier and passes the remainder to main", () => {
    const main = new LinesComponent(["transcript"]);
    const editor = new LinesComponent(["editor", "status"]);
    const viewer = new LinesComponent(["tool viewer"]);
    const layout = new AppLayout({ main, bottom: editor });

    layout.showBottom(viewer);
    const rendered = layout.render(80, 24);

    expect(main.lastAvailableHeight).toBe(12);
    expect(viewer.lastAvailableHeight).toBe(11);
    expect(editor.lastAvailableHeight).toBeUndefined();
    expect(rendered).toHaveLength(13);
  });

  test.each([
    [30, 15],
    [29, 12],
    [24, 12],
    [23, 9],
    [18, 9],
    [17, 7],
    [14, 7],
    [13, 7],
    [8, 7],
    [6, 6],
  ])("uses a %i-row terminal with a %i-row bottom tier", (terminalHeight, bottomHeight) => {
    const main = new LinesComponent(["transcript"]);
    const bottom = new LinesComponent(["bottom"]);
    const layout = new AppLayout({ main, bottom });

    const rendered = layout.render(80, terminalHeight);

    expect(main.lastAvailableHeight).toBe(terminalHeight - bottomHeight);
    expect(bottom.lastAvailableHeight).toBe(Math.max(0, bottomHeight - 1));
    expect(rendered.map(stripAnsi)).toContain(DIVIDER);
    expect(rendered).toHaveLength(bottomHeight + 1);
  });
});
