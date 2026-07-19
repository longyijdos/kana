import type { Component } from "../runtime";

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
    return [
      ...this.main.render(width, availableHeight),
      ...this.bottom.render(width, availableHeight),
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
