import { isDown, isEnd, isHome, isLeft, isPageDown, isPageUp, isRight, isUp } from "../runtime";

export type ListViewportWindow = {
  start: number;
  end: number;
  hiddenBefore: number;
  hiddenAfter: number;
};

export type ListViewportRow<T> = {
  item: T;
  index: number;
  selected: boolean;
};

export class ListViewport {
  selectedIndex = 0;
  start = 0;
  private visibleLimit: number;

  constructor(visibleLimit: number) {
    this.visibleLimit = normalizeVisibleLimit(visibleLimit);
  }

  setVisibleLimit(visibleLimit: number, length: number): void {
    this.visibleLimit = normalizeVisibleLimit(visibleLimit);
    this.ensureSelectedVisible(length);
  }

  move(delta: number, length: number): void {
    this.moveTo(this.selectedIndex + delta, length);
  }

  moveTo(index: number, length: number): void {
    this.selectedIndex = clampIndex(index, length);
    this.ensureSelectedVisible(length);
  }

  // Paging moves the visible window by one page and carries the selection along on
  // the same row. A window already parked at an end cannot move, so the selection
  // falls through to that end instead of staying put.
  movePage(delta: number, length: number): void {
    const previousStart = this.start;
    this.start = clamp(this.start + delta * this.visibleLimit, 0, this.maxStart(length));
    const advanced = this.start - previousStart;
    this.moveTo(
      this.selectedIndex + (advanced === 0 ? delta * this.visibleLimit : advanced),
      length,
    );
  }

  // Applies the shared list keys: arrows move one row, left/right and page
  // keys move one page, Home/End jump to the ends. Returns false for any other
  // key so the component can handle it.
  handleNavigationKey(data: string, length: number): boolean {
    if (isUp(data)) this.move(-1, length);
    else if (isDown(data)) this.move(1, length);
    else if (isLeft(data) || isPageUp(data)) this.movePage(-1, length);
    else if (isRight(data) || isPageDown(data)) this.movePage(1, length);
    else if (isHome(data)) this.moveTo(0, length);
    else if (isEnd(data)) this.moveTo(length - 1, length);
    else return false;
    return true;
  }

  page(delta: number, length: number): void {
    this.scroll(delta * this.visibleLimit, length);
  }

  scroll(delta: number, length: number): void {
    this.start = clamp(this.start + delta, 0, this.maxStart(length));
    this.selectedIndex = this.start;
  }

  window(length: number): ListViewportWindow {
    this.clamp(length);
    const end = Math.min(length, this.start + this.visibleLimit);
    return {
      start: this.start,
      end,
      hiddenBefore: this.start,
      hiddenAfter: length - end,
    };
  }

  visible<T>(items: readonly T[]): ListViewportWindow & { rows: ListViewportRow<T>[] } {
    const window = this.window(items.length);
    const rows = items.slice(window.start, window.end).map((item, offset) => {
      const index = window.start + offset;
      return { item, index, selected: index === this.selectedIndex };
    });
    return { ...window, rows };
  }

  private ensureSelectedVisible(length: number): void {
    this.clamp(length);
    if (this.selectedIndex < this.start) {
      this.start = this.selectedIndex;
    } else if (this.selectedIndex >= this.start + this.visibleLimit) {
      this.start = this.selectedIndex - this.visibleLimit + 1;
    }
  }

  private clamp(length: number): void {
    this.selectedIndex = clampIndex(this.selectedIndex, length);
    this.start = clamp(this.start, 0, this.maxStart(length));
  }

  private maxStart(length: number): number {
    return Math.max(0, length - this.visibleLimit);
  }
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : clamp(index, 0, length - 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function visibleLimitForHeight(
  maximum: number,
  availableHeight: number | undefined,
  reservedRows: number,
): number {
  const normalizedMaximum = normalizeVisibleLimit(maximum);

  if (availableHeight === undefined || !Number.isFinite(availableHeight)) {
    return normalizedMaximum;
  }

  // Height is advisory, so retain one interactive row even when fixed chrome exceeds it.
  return Math.max(
    1,
    Math.min(normalizedMaximum, Math.floor(availableHeight) - Math.max(0, reservedRows)),
  );
}

function normalizeVisibleLimit(value: number): number {
  return Math.max(1, Math.floor(value));
}
