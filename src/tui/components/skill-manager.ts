import { color, dim, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport } from "../utils/list-viewport";

const SKILL_MANAGER_VISIBLE_LIMIT = 10;

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
  private readonly viewport: ListViewport;

  constructor(
    private readonly skills: SkillManagerItem[],
    private readonly finish: (decision: SkillManagerDecision) => void,
    visibleLimit = SKILL_MANAGER_VISIBLE_LIMIT,
  ) {
    this.viewport = new ListViewport(visibleLimit);
  }

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
    const lines = ["", color("Skills", tuiTheme.muted)];

    if (this.skills.length === 0) {
      lines.push(dim("No skills found for this workspace."));
      return lines;
    }

    const viewport = this.viewport.window(this.skills.length);

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier skills`));
    }

    for (let index = viewport.start; index < viewport.end; index += 1) {
      const skill = this.skills[index];
      const selected = index === this.viewport.selectedIndex;
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
        lines.push(truncateToWidth(dim(`  ${formatDescription(skill.description)}`), width, "..."));
      }
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more skills`));
    }

    return lines;
  }

  private toggleSelected(): void {
    const skill = this.skills[this.viewport.selectedIndex];

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
    this.viewport.move(delta, this.skills.length);
  }
}

function formatDescription(description: string): string {
  return description.trim().replace(/\s+/g, " ");
}
