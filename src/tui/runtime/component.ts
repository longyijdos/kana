export interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

export class Container implements Component {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }

  insertChildAfter(anchor: Component, component: Component): void {
    const index = this.children.indexOf(anchor);

    if (index < 0) {
      this.addChild(component);
      return;
    }

    this.children.splice(index + 1, 0, component);
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

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];

    for (const child of this.children) {
      lines.push(...child.render(width));
    }

    return lines;
  }
}
