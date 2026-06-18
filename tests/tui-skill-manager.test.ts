import { describe, expect, test } from "bun:test";
import { SkillManager, type SkillManagerDecision } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";

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

    const rendered = manager.render(80).map(stripAnsi);

    expect(rendered).toContain("Skills");
    expect(rendered).toContain("> [x] project-skill  project locked");
    expect(rendered).toContain("  Project-local skill.");
    expect(rendered).toContain("  [ ] global-skill  global");
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

  test("toggles mutable global skills with enter", () => {
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

    expect(decisions).toEqual([
      {
        type: "toggle",
        item: {
          name: "global-skill",
          description: "Global skill.",
          scope: "global",
          enabled: true,
          mutable: true,
        },
        enabled: true,
      },
    ]);
    expect(manager.render(80).map(stripAnsi)).toContain("> [x] global-skill  global");
  });

  test("renders only the visible skill window", () => {
    const skills = Array.from({ length: 5 }, (_, index) => ({
      name: `skill-${index + 1}`,
      description: `Skill ${index + 1}.`,
      scope: "global" as const,
      enabled: false,
      mutable: true,
    }));
    const manager = new SkillManager(skills, () => {}, 3);

    expect(manager.render(80).map(stripAnsi)).toEqual([
      "",
      "Skills",
      "> [ ] skill-1  global",
      "  Skill 1.",
      "  [ ] skill-2  global",
      "  [ ] skill-3  global",
      "... 2 more skills",
    ]);

    manager.handleInput("\x1b[B");
    manager.handleInput("\x1b[B");
    manager.handleInput("\x1b[B");

    expect(manager.render(80).map(stripAnsi)).toEqual([
      "",
      "Skills",
      "... 1 earlier skills",
      "  [ ] skill-2  global",
      "  [ ] skill-3  global",
      "> [ ] skill-4  global",
      "  Skill 4.",
      "... 1 more skills",
    ]);
  });

  test("does not wrap selection at list boundaries", () => {
    const skills = [
      {
        name: "first-skill",
        description: "",
        scope: "global" as const,
        enabled: false,
        mutable: true,
      },
      {
        name: "second-skill",
        description: "",
        scope: "global" as const,
        enabled: false,
        mutable: true,
      },
    ];
    const manager = new SkillManager(skills, () => {});

    manager.handleInput("\x1b[A");
    expect(manager.render(80).map(stripAnsi)).toContain("> [ ] first-skill  global");

    manager.handleInput("\x1b[B");
    manager.handleInput("\x1b[B");
    expect(manager.render(80).map(stripAnsi)).toContain("> [ ] second-skill  global");
  });

  test("closes with escape", () => {
    let decision: SkillManagerDecision | undefined;
    const manager = new SkillManager([], (nextDecision) => {
      decision = nextDecision;
    });

    manager.handleInput("\x1b");

    expect(decision).toEqual({ type: "close" });
  });
});
