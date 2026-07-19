import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import type { Component } from "../src/tui/runtime";

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

    expect(layout.render(80)).toEqual(["transcript", "editor", "status"]);

    const viewerMain = new LinesComponent(["viewer main"]);
    const viewer = new LinesComponent(["tool viewer"]);

    layout.showMain(viewerMain);
    layout.showBottom(viewer);

    expect(layout.render(80)).toEqual(["viewer main", "tool viewer"]);
    expect(layout.isMain(viewerMain)).toBe(true);
    expect(layout.isMain(main)).toBe(false);
    expect(layout.isBottom(viewer)).toBe(true);
    expect(layout.isBottom(editor)).toBe(false);

    layout.showMain(main);
    layout.showBottom(editor);

    expect(layout.render(80)).toEqual(["transcript", "editor", "status"]);
  });

  test("passes the available height hint to main and the active bottom", () => {
    const main = new LinesComponent(["transcript"]);
    const editor = new LinesComponent(["editor", "status"]);
    const viewer = new LinesComponent(["tool viewer"]);
    const layout = new AppLayout({ main, bottom: editor });

    layout.showBottom(viewer);
    layout.render(80, 16);

    expect(main.lastAvailableHeight).toBe(16);
    expect(viewer.lastAvailableHeight).toBe(16);
    expect(editor.lastAvailableHeight).toBeUndefined();
  });
});
