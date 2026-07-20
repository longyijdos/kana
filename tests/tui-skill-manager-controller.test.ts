import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import { SkillManagerController } from "../src/tui/app/skill-manager-controller";
import { Editor, Transcript } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";
import type { Component, Tui } from "../src/tui/runtime";

describe("skill manager controller", () => {
  test("replaces the editor with the manager and restores it after close", () => {
    const editor = new Editor({ model: "test-model" });
    const transcript = new Transcript();
    const layout = new AppLayout({ main: transcript, bottom: editor });
    const tui = createTuiStub();
    const restoreCalls: boolean[] = [];
    const restoreBottom = (focus: boolean): void => {
      restoreCalls.push(focus);
      layout.showBottom(editor);
      if (focus) {
        tui.setFocus(editor);
      }
    };
    const controller = new SkillManagerController({
      editor,
      layout,
      transcript,
      tui,
      loadSkills: () => ({
        skills: [],
        globalEnabledSkillNames: [],
        diagnostics: [],
      }),
      saveEnabledGlobalSkills: () => {},
      onSkillsChanged: () => {},
      updateStatus: () => {},
      restoreBottom,
    });

    controller.open();

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Skills");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("test-model");

    tui.getFocus()?.handleInput?.("\x1b");

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("test-model");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("Skills");
    expect(tui.getFocus()).toBe(editor);
    expect(restoreCalls).toEqual([true]);
  });
});

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
