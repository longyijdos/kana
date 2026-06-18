export type ListViewportWindow = {
  start: number;
  end: number;
  hiddenBefore: number;
  hiddenAfter: number;
};

export class ListViewport {
  selectedIndex = 0;
  start = 0;

  constructor(readonly visibleLimit: number) {}

  move(delta: number, length: number): void {
    if (length === 0) {
      this.selectedIndex = 0;
      this.start = 0;
      return;
    }

    this.selectedIndex = clamp(this.selectedIndex + delta, 0, length - 1);
    this.ensureSelectedVisible(length);
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
