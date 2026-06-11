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

  render(width: number): string[] {
    const lines: string[] = [];

    for (const child of this.children) {
      lines.push(...child.render(width));
    }

    return lines;
  }
}
