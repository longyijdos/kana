import type { Component, Tui } from "../runtime";
import type { AppLayout } from "./app-layout";

export type BottomAreaControllerOptions = {
  layout: AppLayout;
  tui: Tui;
  fallback: Component;
};

export class BottomAreaController {
  private getFallback: () => Component;

  constructor(private readonly options: BottomAreaControllerOptions) {
    this.getFallback = () => options.fallback;
  }

  setFallback(getFallback: () => Component): void {
    this.getFallback = getFallback;
  }

  show(component: Component, focus = true): void {
    this.options.layout.showBottom(component);
    if (focus) {
      this.options.tui.setFocus(component);
    }
    this.options.tui.requestRender();
  }

  showFallback(focus = true): void {
    this.show(this.getFallback(), focus);
  }

  clearFocus(): void {
    this.options.tui.setFocus(undefined);
  }

  restore(component: Component, focus = this.hasFocus(component)): boolean {
    if (!this.isShowing(component)) {
      this.options.tui.requestRender();
      return false;
    }

    this.showFallback(focus);
    return true;
  }

  isShowing(component: Component): boolean {
    return this.options.layout.isBottom(component);
  }

  hasFocus(component: Component): boolean {
    return this.options.tui.getFocus() === component;
  }
}
