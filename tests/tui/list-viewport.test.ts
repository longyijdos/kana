import { describe, expect, test } from "bun:test";
import { ListViewport, visibleLimitForHeight } from "../../src/tui/utils/list-viewport";

describe("list viewport", () => {
  test("clamps movement and keeps the selected item visible", () => {
    const viewport = new ListViewport(3);

    viewport.move(-1, 5);
    expect(viewport.selectedIndex).toBe(0);
    expect(viewport.window(5)).toEqual({
      start: 0,
      end: 3,
      hiddenBefore: 0,
      hiddenAfter: 2,
    });

    viewport.moveTo(10, 5);
    expect(viewport.selectedIndex).toBe(4);
    expect(viewport.window(5)).toEqual({
      start: 2,
      end: 5,
      hiddenBefore: 2,
      hiddenAfter: 0,
    });

    viewport.move(1, 5);
    expect(viewport.selectedIndex).toBe(4);
  });

  test("keeps the selected item visible when the limit changes", () => {
    const viewport = new ListViewport(5);

    viewport.moveTo(3, 5);
    viewport.setVisibleLimit(2, 5);

    expect(viewport.window(5)).toEqual({
      start: 2,
      end: 4,
      hiddenBefore: 2,
      hiddenAfter: 1,
    });

    viewport.setVisibleLimit(5, 5);
    expect(viewport.window(5)).toEqual({
      start: 0,
      end: 5,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
  });

  test("pages and scrolls within the available window", () => {
    const viewport = new ListViewport(3);

    viewport.page(1, 10);
    expect(viewport.selectedIndex).toBe(3);
    expect(viewport.start).toBe(3);

    viewport.scroll(1, 10);
    expect(viewport.selectedIndex).toBe(4);
    expect(viewport.start).toBe(4);

    viewport.page(10, 10);
    expect(viewport.selectedIndex).toBe(7);
    expect(viewport.start).toBe(7);

    viewport.scroll(-10, 10);
    expect(viewport.selectedIndex).toBe(0);
    expect(viewport.start).toBe(0);
  });

  test("resets selection and window state for an empty list", () => {
    const viewport = new ListViewport(2);

    viewport.moveTo(3, 4);

    expect(viewport.window(0)).toEqual({
      start: 0,
      end: 0,
      hiddenBefore: 0,
      hiddenAfter: 0,
    });
    expect(viewport.selectedIndex).toBe(0);
    expect(viewport.start).toBe(0);
  });
});

describe("visible list limit", () => {
  test("uses the maximum without a finite height hint", () => {
    expect(visibleLimitForHeight(10, undefined, 3)).toBe(10);
    expect(visibleLimitForHeight(10, Number.POSITIVE_INFINITY, 3)).toBe(10);
  });

  test("subtracts reserved rows while retaining one interactive row", () => {
    expect(visibleLimitForHeight(10, 7.8, 3)).toBe(4);
    expect(visibleLimitForHeight(10, 2, 3)).toBe(1);
    expect(visibleLimitForHeight(3, 20, 3)).toBe(3);
  });
});
