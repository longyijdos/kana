import type { Component } from "../runtime";

const BOTTOM_HEIGHT_TIERS = [
  { minimumTerminalHeight: 30, bottomHeight: 15 },
  { minimumTerminalHeight: 24, bottomHeight: 12 },
  { minimumTerminalHeight: 18, bottomHeight: 9 },
  { minimumTerminalHeight: 7, bottomHeight: 7 },
] as const;

export type AppLayoutOptions = {
  main: Component;
  bottom: Component;
};

export class AppLayout implements Component {
  private main: Component;
  private bottom: Component;

  constructor(options: AppLayoutOptions) {
    this.main = options.main;
    this.bottom = options.bottom;
  }

  showMain(component: Component): void {
    this.main = component;
  }

  isMain(component: Component): boolean {
    return this.main === component;
  }

  showBottom(component: Component): void {
    this.bottom = component;
  }

  isBottom(component: Component): boolean {
    return this.bottom === component;
  }

  render(width: number, availableHeight?: number): string[] {
    const bottomHeight = resolveBottomHeight(availableHeight);
    const mainHeight =
      availableHeight === undefined || !Number.isFinite(availableHeight)
        ? undefined
        : Math.max(0, Math.floor(availableHeight) - bottomHeight);
    const bottomLines = this.bottom.render(width, bottomHeight);

    // Layout owns padding so swapping bottom components cannot move the main boundary.
    return [
      ...this.main.render(width, mainHeight),
      ...bottomLines,
      ...Array.from({ length: Math.max(0, bottomHeight - bottomLines.length) }, () => ""),
    ];
  }

  invalidate(): void {
    invalidateComponent(this.main);
    invalidateComponent(this.bottom);
  }
}

function invalidateComponent(component: Component | undefined): void {
  component?.invalidate?.();
}

function resolveBottomHeight(availableHeight: number | undefined): number {
  if (availableHeight === undefined || !Number.isFinite(availableHeight)) {
    return BOTTOM_HEIGHT_TIERS[0].bottomHeight;
  }

  const terminalHeight = Math.max(1, Math.floor(availableHeight));
  const tier = BOTTOM_HEIGHT_TIERS.find(
    ({ minimumTerminalHeight }) => terminalHeight >= minimumTerminalHeight,
  );

  // Seven rows keep approval context and choices visible; smaller terminals
  // receive all available rows because no complete bottom layout can fit.
  return tier?.bottomHeight ?? terminalHeight;
}
