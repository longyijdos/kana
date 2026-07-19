export type ListViewportWindow = {
  start: number;
  end: number;
  hiddenBefore: number;
  hiddenAfter: number;
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
    if (length === 0) {
      this.selectedIndex = 0;
      this.start = 0;
      return;
    }

    this.selectedIndex = clamp(this.selectedIndex + delta, 0, length - 1);
    this.ensureSelectedVisible(length);
  }

  moveTo(index: number, length: number): void {
    if (length === 0) {
      this.selectedIndex = 0;
      this.start = 0;
      return;
    }

    this.selectedIndex = clamp(index, 0, length - 1);
    this.ensureSelectedVisible(length);
  }

  page(delta: number, length: number): void {
    if (length === 0) {
      this.selectedIndex = 0;
      this.start = 0;
      return;
    }

    const visibleLimit = Math.max(1, this.visibleLimit);
    const maxStart = Math.max(0, length - visibleLimit);

    this.start = clamp(this.start + delta * visibleLimit, 0, maxStart);
    this.selectedIndex = this.start;
  }

  scroll(delta: number, length: number): void {
    if (length === 0) {
      this.selectedIndex = 0;
      this.start = 0;
      return;
    }

    const visibleLimit = Math.max(1, this.visibleLimit);
    const maxStart = Math.max(0, length - visibleLimit);

    this.start = clamp(this.start + delta, 0, maxStart);
    this.selectedIndex = this.start;
  }

  window(length: number): ListViewportWindow {
    this.clamp(length);

    const visibleLimit = Math.max(1, this.visibleLimit);
    const start = Math.min(this.start, Math.max(0, length - visibleLimit));
    const end = Math.min(length, start + visibleLimit);

    this.start = start;

    return {
      start,
      end,
      hiddenBefore: start,
      hiddenAfter: Math.max(0, length - end),
    };
  }

  private ensureSelectedVisible(length: number): void {
    this.clamp(length);

    const visibleLimit = Math.max(1, this.visibleLimit);

    if (this.selectedIndex < this.start) {
      this.start = this.selectedIndex;
      return;
    }

    if (this.selectedIndex >= this.start + visibleLimit) {
      this.start = this.selectedIndex - visibleLimit + 1;
    }
  }

  private clamp(length: number): void {
    if (length === 0) {
      this.selectedIndex = 0;
      this.start = 0;
      return;
    }

    const visibleLimit = Math.max(1, this.visibleLimit);

    this.selectedIndex = Math.min(this.selectedIndex, length - 1);
    this.start = Math.min(this.start, Math.max(0, length - visibleLimit));
  }
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
