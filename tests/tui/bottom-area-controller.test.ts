import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import type { Component, Tui } from "../../src/tui/runtime";

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("bottom area controller", () => {
  test("shows a component and restores the configured fallback with focus", () => {
    const editor = new LinesComponent(["editor"]);
    const overlay = new LinesComponent(["overlay"]);
    const layout = new AppLayout({ main: new LinesComponent(["main"]), bottom: editor });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });

    bottomArea.show(overlay);

    expect(bottomArea.isShowing(overlay)).toBe(true);
    expect(tui.getFocus()).toBe(overlay);
    expect(bottomArea.restore(overlay)).toBe(true);
    expect(bottomArea.isShowing(editor)).toBe(true);
    expect(tui.getFocus()).toBe(editor);

    bottomArea.clearFocus();

    expect(bottomArea.isShowing(editor)).toBe(true);
    expect(tui.getFocus()).toBeUndefined();
  });

  test("does not let a stale owner replace a newer bottom component", () => {
    const editor = new LinesComponent(["editor"]);
    const waitingPrompt = new LinesComponent(["approval"]);
    const viewer = new LinesComponent(["viewer"]);
    const newerOverlay = new LinesComponent(["newer"]);
    const layout = new AppLayout({ main: new LinesComponent(["main"]), bottom: editor });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    bottomArea.setFallback(() => waitingPrompt);

    bottomArea.show(viewer);
    bottomArea.show(newerOverlay);

    expect(bottomArea.restore(viewer)).toBe(false);
    expect(bottomArea.isShowing(newerOverlay)).toBe(true);
    expect(tui.getFocus()).toBe(newerOverlay);

    expect(bottomArea.restore(newerOverlay)).toBe(true);
    expect(bottomArea.isShowing(waitingPrompt)).toBe(true);
    expect(tui.getFocus()).toBe(waitingPrompt);
  });
});

function createTuiStub(): Tui {
  let focused: Component | undefined;

  return {
    getFocus: () => focused,
    setFocus: (component: Component | undefined) => {
      focused = component;
    },
    requestRender: () => {},
  } as unknown as Tui;
}
