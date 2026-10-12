import { collapseWhitespace, color, dim, setsEqual, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isEnter, isEscape } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const SKILL_MANAGER_VISIBLE_LIMIT = 10;
const SKILL_MANAGER_RESERVED_ROWS = 6;

export type SkillManagerItem = {
  name: string;
  description: string;
  scope: "project" | "global";
  enabled: boolean;
  mutable: boolean;
};

export type SkillManagerDecision = {
  type: "apply";
  enabledGlobalSkillNames: string[];
  changed: boolean;
};

export class SkillManager implements Component {
  private readonly viewport: ListViewport;
  private readonly maximumVisibleSkills: number;
  private readonly initialEnabledGlobalSkillNames: Set<string>;

  constructor(
    private readonly skills: SkillManagerItem[],
    private readonly finish: (decision: SkillManagerDecision) => void,
    visibleLimit = SKILL_MANAGER_VISIBLE_LIMIT,
  ) {
    this.maximumVisibleSkills = visibleLimit;
    this.viewport = new ListViewport(this.maximumVisibleSkills);
    this.initialEnabledGlobalSkillNames = new Set(
      skills
        .filter((skill) => skill.scope === "global" && skill.enabled)
        .map((skill) => skill.name),
    );
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      const enabledGlobalSkillNames = this.skills
        .filter((skill) => skill.scope === "global" && skill.enabled)
        .map((skill) => skill.name);
      this.finish({
        type: "apply",
        enabledGlobalSkillNames,
        changed: !setsEqual(this.initialEnabledGlobalSkillNames, new Set(enabledGlobalSkillNames)),
      });
      return;
    }

    if (isEnter(data)) {
      this.toggleSelected();
      return;
    }

    if (this.viewport.handleNavigationKey(data, this.skills.length)) {
      return;
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const lines = [
      color("Skills", tuiTheme.bottomTitle),
      truncateToWidth(
        dim("Disabled Skills are manual-only; all Skills remain available through @."),
        width,
      ),
    ];

    if (this.skills.length === 0) {
      lines.push(dim("No skills found for this workspace."), dim("Esc close"));
      return lines;
    }

    this.viewport.setVisibleLimit(
      visibleLimitForHeight(
        this.maximumVisibleSkills,
        availableHeight,
        SKILL_MANAGER_RESERVED_ROWS,
      ),
      this.skills.length,
    );
    const viewport = this.viewport.visible(this.skills);

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier skills`));
    }

    for (const { item: skill, selected } of viewport.rows) {
      const marker = selected ? "> " : "  ";
      const checkbox = skill.enabled ? "[x]" : "[ ]";
      const scope = skill.mutable ? "global" : "project";
      const lock = skill.mutable ? "" : " locked";
      const label = `${marker}${checkbox} ${skill.name}  ${scope}${lock}`;
      const rendered = selected
        ? color(label, skill.mutable ? tuiTheme.user : tuiTheme.muted)
        : color(label, tuiTheme.muted);

      lines.push(truncateToWidth(rendered, width));

      if (selected && skill.description.trim()) {
        lines.push(truncateToWidth(dim(`  ${collapseWhitespace(skill.description)}`), width));
      }
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more skills`));
    }

    lines.push(truncateToWidth(dim("Enter toggle automatic use · Esc apply and close"), width));
    return lines;
  }

  private toggleSelected(): void {
    const skill = this.skills[this.viewport.selectedIndex];

    if (!skill?.mutable) {
      return;
    }

    skill.enabled = !skill.enabled;
  }
}
