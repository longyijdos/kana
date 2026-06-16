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

  test("closes with escape", () => {
    let decision: SkillManagerDecision | undefined;
    const manager = new SkillManager([], (nextDecision) => {
      decision = nextDecision;
    });

    manager.handleInput("\x1b");

    expect(decision).toEqual({ type: "close" });
  });
});
