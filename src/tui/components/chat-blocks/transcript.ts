import type { Component } from "../../runtime/component";

export class Transcript implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
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
