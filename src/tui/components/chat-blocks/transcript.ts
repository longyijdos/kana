import type { Component } from "../../runtime";

export class Transcript implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  removeChild(component: Component): void {
    const index = this.children.indexOf(component);

    if (index >= 0) {
      this.children.splice(index, 1);
    }
  }

  clear(): void {
    this.children.length = 0;
  }

  render(width: number, availableHeight?: number): string[] {
    const lines: string[] = [];
    let hasRenderedChild = false;

    for (const child of this.children) {
      const childLines = child.render(width, availableHeight);

      if (childLines.length === 0) {
        continue;
      }

      if (hasRenderedChild) {
        lines.push("");
      }

      lines.push(...childLines);
      hasRenderedChild = true;
    }

    return lines;
  }
}
