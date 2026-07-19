import type { Component } from "../runtime";

export type AppLayoutOptions = {
  transcript: Component;
  editor: Component;
  status: Component;
};

export class AppLayout implements Component {
  private main: Component;
  private inlinePrompt?: Component;
  private overlay?: Component;

  constructor(private readonly options: AppLayoutOptions) {
    this.main = options.transcript;
  }

  showMain(component: Component): void {
    this.main = component;
  }

  showTranscript(): void {
    this.main = this.options.transcript;
  }

  showInlinePrompt(component: Component): void {
    this.inlinePrompt = component;
  }

  clearInlinePrompt(component?: Component): void {
    if (!component || this.inlinePrompt === component) {
      this.inlinePrompt = undefined;
    }
  }

  showOverlay(component: Component): void {
    this.overlay = component;
  }

  clearOverlay(component?: Component): void {
    if (!component || this.overlay === component) {
      this.overlay = undefined;
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const lines = [...this.main.render(width, availableHeight)];

    if (this.inlinePrompt) {
      lines.push(...this.inlinePrompt.render(width, availableHeight));
    }

    lines.push(...this.options.editor.render(width, availableHeight));

    if (this.overlay) {
      lines.push(...this.overlay.render(width, availableHeight));
    }

    lines.push(...this.options.status.render(width, availableHeight));

    return lines;
  }

  invalidate(): void {
    invalidateComponent(this.main);
    invalidateComponent(this.inlinePrompt);
    invalidateComponent(this.options.editor);
    invalidateComponent(this.overlay);
    invalidateComponent(this.options.status);
  }
}

function invalidateComponent(component: Component | undefined): void {
  component?.invalidate?.();
}
