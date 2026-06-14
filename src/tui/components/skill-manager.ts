import { color, dim, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import {
  isDown,
  isEnter,
  isEscape,
  isUp,
} from "../runtime";
import { tuiTheme } from "../theme";

export type SkillManagerItem = {
  name: string;
  description: string;
  scope: "project" | "global";
  enabled: boolean;
  mutable: boolean;
};

export type SkillManagerDecision =
  | {
      type: "close";
    }
  | {
      type: "toggle";
      item: SkillManagerItem;
      enabled: boolean;
    };

export class SkillManager implements Component {
  private selectedIndex = 0;

  constructor(
    private readonly skills: SkillManagerItem[],
    private readonly finish: (decision: SkillManagerDecision) => void,
  ) {}

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.finish({ type: "close" });
      return;
    }

    if (isEnter(data)) {
      this.toggleSelected();
      return;
    }

    if (isUp(data)) {
      this.move(-1);
      return;
    }

    if (isDown(data)) {
      this.move(1);
    }
  }

  render(width: number): string[] {
    const lines = [
      "",
      color("Skills", tuiTheme.muted),
    ];

    if (this.skills.length === 0) {
      lines.push(dim("No skills found for this workspace."));
      return lines;
    }

    for (const [index, skill] of this.skills.entries()) {
      const selected = index === this.selectedIndex;
      const marker = selected ? "> " : "  ";
      const checkbox = skill.enabled ? "[x]" : "[ ]";
      const scope = skill.mutable ? "global" : "project";
      const lock = skill.mutable ? "" : " locked";
      const label = `${marker}${checkbox} ${skill.name}  ${scope}${lock}`;
      const rendered = selected
        ? color(label, skill.mutable ? tuiTheme.user : tuiTheme.muted)
        : color(label, tuiTheme.muted);

      lines.push(truncateToWidth(rendered, width, ""));

      if (selected && skill.description.trim()) {
        lines.push(
          truncateToWidth(
            dim(`  ${formatDescription(skill.description)}`),
            width,
            "...",
          ),
        );
      }
    }

    return lines;
  }

  private toggleSelected(): void {
    const skill = this.skills[this.selectedIndex];

    if (!skill?.mutable) {
      return;
    }

    skill.enabled = !skill.enabled;
    this.finish({
      type: "toggle",
      item: skill,
      enabled: skill.enabled,
    });
  }

  private move(delta: number): void {
    if (this.skills.length === 0) {
      return;
    }

    this.selectedIndex =
      (this.selectedIndex + delta + this.skills.length) % this.skills.length;
  }
}

function formatDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ");
}
