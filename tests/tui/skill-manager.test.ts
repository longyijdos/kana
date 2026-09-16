import { describe, expect, test } from "bun:test";
import { SkillManager, type SkillManagerDecision } from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";

describe("skill manager", () => {
  test("renders global and project skills as checkboxes", () => {
    const manager = new SkillManager(
      [
        {
          name: "project-skill",
          description: "Project-local skill.",
          scope: "project",
          enabled: true,
          mutable: false,
        },
        {
          name: "global-skill",
          description: "Global skill.",
          scope: "global",
          enabled: false,
          mutable: true,
        },
      ],
      () => {},
    );

    const rawRendered = manager.render(80);
    const rendered = rawRendered.map(stripAnsi);

    expect(rendered).toContain("Skills");
    expect(rendered).toContain(
      "Disabled Skills are manual-only; all Skills remain available through @.",
    );
    expect(rendered).toContain("> [x] project-skill  project locked");
    expect(rendered).toContain("  Project-local skill.");
    expect(rendered).toContain("  [ ] global-skill  global");
    expect(rendered).toContain("Enter toggle automatic use · Esc apply and close");
    expect(rawRendered[0]).toBe(color("Skills", tuiTheme.bottomTitle));
  });

  test("renders multiline descriptions as a single logical line", () => {
    const manager = new SkillManager(
      [
        {
          name: "global-skill",
          description: "First line.\nSecond line.",
          scope: "global",
          enabled: false,
          mutable: true,
        },
      ],
      () => {},
    );

    const rendered = manager.render(80).map(stripAnsi);

    expect(rendered).toContain("  First line. Second line.");
    expect(rendered.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);
  });

  test("truncates long descriptions with an ellipsis", () => {
    const manager = new SkillManager(
      [
        {
          name: "global-skill",
          description: "A long description that does not fit.",
          scope: "global",
          enabled: false,
          mutable: true,
        },
      ],
      () => {},
    );

    const rendered = manager.render(20).map(stripAnsi);

    expect(rendered).toContain("  A long descript...");
  });

  test("keeps mutable global skill toggles as a draft until escape applies once", () => {
    const decisions: SkillManagerDecision[] = [];
    const manager = new SkillManager(
      [
        {
          name: "project-skill",
          description: "Project-local skill.",
          scope: "project",
          enabled: true,
          mutable: false,
        },
        {
          name: "global-skill",
          description: "Global skill.",
          scope: "global",
          enabled: false,
          mutable: true,
        },
      ],
      (decision) => {
        decisions.push(decision);
      },
    );

    manager.handleInput("\r");
    manager.handleInput("\x1b[B");
    manager.handleInput("\r");

    expect(decisions).toEqual([]);
    expect(manager.render(80).map(stripAnsi)).toContain("> [x] global-skill  global");

    manager.handleInput("\x1b");
    expect(decisions).toEqual([
      {
        type: "apply",
        enabledGlobalSkillNames: ["global-skill"],
        changed: true,
      },
    ]);
  });

  test("renders only the visible skill window", () => {
    const skills = createSkills(5);
    const manager = new SkillManager(skills, () => {}, 3);

    expect(manager.render(80).map(stripAnsi)).toEqual([
      "Skills",
      "Disabled Skills are manual-only; all Skills remain available through @.",
      "> [ ] skill-1  global",
      "  Skill 1.",
      "  [ ] skill-2  global",
      "  [ ] skill-3  global",
      "... 2 more skills",
      "Enter toggle automatic use · Esc apply and close",
    ]);

    manager.handleInput("\x1b[B");
    manager.handleInput("\x1b[B");
    manager.handleInput("\x1b[B");

    expect(manager.render(80).map(stripAnsi)).toEqual([
      "Skills",
      "Disabled Skills are manual-only; all Skills remain available through @.",
      "... 1 earlier skills",
      "  [ ] skill-2  global",
      "  [ ] skill-3  global",
      "> [ ] skill-4  global",
      "  Skill 4.",
      "... 1 more skills",
      "Enter toggle automatic use · Esc apply and close",
    ]);
  });

  test("pages by a full window and jumps to the ends", () => {
    const skills = createSkills(10);
    const manager = new SkillManager(skills, () => {}, 3);

    manager.handleInput("\x1b[6~");
    expect(selectedSkill(manager)).toBe("> [ ] skill-4  global");

    manager.handleInput("\x1b[C");
    expect(selectedSkill(manager)).toBe("> [ ] skill-7  global");

    manager.handleInput("\x1b[4~");
    expect(selectedSkill(manager)).toBe("> [ ] skill-10  global");

    manager.handleInput("\x1b[D");
    expect(selectedSkill(manager)).toBe("> [ ] skill-7  global");

    manager.handleInput("\x1b[1~");
    expect(selectedSkill(manager)).toBe("> [ ] skill-1  global");

    manager.handleInput("\x1b[5~");
    expect(selectedSkill(manager)).toBe("> [ ] skill-1  global");
  });

  test("applies an unchanged empty draft with escape", () => {
    let decision: SkillManagerDecision | undefined;
    const manager = new SkillManager([], (nextDecision) => {
      decision = nextDecision;
    });

    manager.handleInput("\x1b");

    expect(decision).toEqual({
      type: "apply",
      enabledGlobalSkillNames: [],
      changed: false,
    });
  });
});

function selectedSkill(manager: SkillManager): string | undefined {
  return manager
    .render(80)
    .map(stripAnsi)
    .find((line) => line.startsWith("> "));
}

function createSkills(length: number) {
  return Array.from({ length }, (_, index) => ({
    name: `skill-${index + 1}`,
    description: `Skill ${index + 1}.`,
    scope: "global" as const,
    enabled: false,
    mutable: true,
  }));
}
