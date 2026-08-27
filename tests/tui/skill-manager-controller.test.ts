import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { SkillManagerController } from "../../src/tui/app/skill-manager-controller";
import { Editor, TextBlock, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("skill manager controller", () => {
  test("saves and refreshes once when an edited draft closes", () => {
    const harness = createHarness();

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\x1b[B");
    harness.tui.getFocus()?.handleInput?.("\r");

    expect(harness.saved).toEqual([]);
    expect(harness.refreshCount()).toBe(0);

    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.saved).toEqual([["global-a", "global-b"]]);
    expect(harness.refreshCount()).toBe(1);
    expect(harness.controller.active).toBe(false);
    expect(harness.layout.isBottom(harness.editor)).toBe(true);
    expect(harness.tui.getFocus()).toBe(harness.editor);
  });

  test("closes an unchanged draft without saving or refreshing", () => {
    const harness = createHarness();

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.saved).toEqual([]);
    expect(harness.refreshCount()).toBe(0);
    expect(harness.controller.active).toBe(false);
  });

  test("keeps the manager open when activation persistence fails", () => {
    const harness = createHarness({
      save: () => {
        throw new Error("skill activation write failed");
      },
    });

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\x1b[B");
    harness.tui.getFocus()?.handleInput?.("\r");
    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.controller.active).toBe(true);
    expect(harness.refreshCount()).toBe(0);
    expect(harness.tui.getFocus()).not.toBe(harness.editor);
    expect(stripAnsi(harness.transcript.render(80).join("\n"))).toContain(
      "skill activation write failed",
    );
  });

  test("closes the saved draft when Agent refresh fails", () => {
    const harness = createHarness({
      refresh: () => {
        throw new Error("skill refresh failed");
      },
    });

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\x1b[B");
    harness.tui.getFocus()?.handleInput?.("\r");
    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.saved).toEqual([["global-a", "global-b"]]);
    expect(harness.controller.active).toBe(false);
    expect(harness.tui.getFocus()).toBe(harness.editor);
    expect(stripAnsi(harness.transcript.render(80).join("\n"))).toContain("skill refresh failed");
  });
});

function createHarness(options: { save?: () => void; refresh?: () => void } = {}) {
  const editor = new Editor({ model: "test-model" });
  const transcript = new Transcript();
  const layout = new AppLayout({ main: transcript, bottom: editor });
  const tui = createTuiStub();
  const saved: string[][] = [];
  let refreshCount = 0;
  const controller = new SkillManagerController({
    editor,
    bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
    loadSkills: () => ({
      skills: [
        {
          name: "project-skill",
          description: "Project-local skill.",
          filePath: "/workspace/.kana/skills/project-skill/SKILL.md",
          baseDir: "/workspace/.kana/skills/project-skill",
          scope: "project",
          enabled: true,
          mutable: false,
        },
        {
          name: "global-a",
          description: "Global A.",
          filePath: "/home/.kana/skills/global-a/SKILL.md",
          baseDir: "/home/.kana/skills/global-a",
          scope: "global",
          enabled: false,
          mutable: true,
        },
        {
          name: "global-b",
          description: "Global B.",
          filePath: "/home/.kana/skills/global-b/SKILL.md",
          baseDir: "/home/.kana/skills/global-b",
          scope: "global",
          enabled: true,
          mutable: true,
        },
      ],
      diagnostics: [],
    }),
    saveEnabledGlobalSkills: (names) => {
      saved.push(names);
      options.save?.();
    },
    onSkillsChanged: () => {
      refreshCount += 1;
      options.refresh?.();
    },
    showError: (error) => {
      transcript.addChild(new TextBlock(error instanceof Error ? error.message : String(error)));
    },
    updateStatus: () => {},
  });

  return {
    controller,
    editor,
    transcript,
    layout,
    tui,
    saved,
    refreshCount: () => refreshCount,
  };
}

function createTuiStub(): Tui {
  let focusedComponent: Component | undefined;

  return {
    requestRender: () => {},
    getFocus: () => focusedComponent,
    setFocus: (component: Component | undefined) => {
      focusedComponent = component;
    },
  } as unknown as Tui;
}
