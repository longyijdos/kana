import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { SlashCommandOptionsController } from "../../src/tui/app/slash-command-options-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("slash command options controller", () => {
  test("collects a memory compact scope and optional request", () => {
    const harness = createHarness();

    harness.controller.openMemory();
    harness.input("\x1b[B");
    harness.input("\r");

    expect(harness.render()).toContain("Memory scope");
    expect(harness.render()).toContain("> Project");

    harness.input("\x1b[B");
    harness.input("\r");

    expect(harness.render()).toContain("Global compaction request (optional)");

    harness.input("Keep completed work");
    harness.input("\r");

    expect(harness.compactCalls).toEqual([{ scope: "global", request: "Keep completed work" }]);
    expect(harness.controller.active).toBe(false);
    expect(harness.render().some((line) => line.includes("test-model"))).toBe(true);
  });

  test("submits an empty compact request as undefined", () => {
    const harness = createHarness();

    harness.controller.openMemory();
    harness.input("\x1b[B");
    harness.input("\r");
    harness.input("\r");
    harness.input("\r");

    expect(harness.compactCalls).toEqual([{ scope: "project", request: undefined }]);
  });

  test("opens the selected memory scope for viewing", () => {
    const harness = createHarness();

    harness.controller.openMemory();
    harness.input("\r");
    harness.input("\x1b[B");
    harness.input("\x1b[B");
    harness.input("\r");

    expect(harness.showCalls).toEqual(["both"]);
    expect(harness.controller.active).toBe(false);
  });

  test("returns through memory prompt steps with escape", () => {
    const harness = createHarness();

    harness.controller.openMemory();
    harness.input("\x1b[B");
    harness.input("\r");
    harness.input("\x1b[B");
    harness.input("\r");
    harness.input("\x1b");

    expect(harness.render()).toContain("Memory scope");
    expect(harness.render()).toContain("> Global");

    harness.input("\x1b");

    expect(harness.render()).toContain("Memory action");
    expect(harness.render()).toContain("> Compact");

    harness.input("\x1b");

    expect(harness.controller.active).toBe(false);
    expect(harness.render().some((line) => line.includes("test-model"))).toBe(true);
    expect(harness.restoreCalls).toEqual([true]);
  });
});

function createHarness() {
  const editor = new Editor({ model: "test-model" });
  const layout = new AppLayout({ main: new Transcript(), bottom: editor });
  const tui = createTuiStub();
  const compactCalls: Array<{ scope: string; request: string | undefined }> = [];
  const showCalls: string[] = [];
  const restoreCalls: boolean[] = [];
  const restoreBottom = (focus: boolean): void => {
    restoreCalls.push(focus);
    layout.showBottom(editor);
    if (focus) {
      tui.setFocus(editor);
    }
  };
  const controller = new SlashCommandOptionsController({
    editor,
    layout,
    tui,
    onUsageScope: () => {},
    onMemoryShow: (scope) => {
      showCalls.push(scope);
      restoreBottom(true);
    },
    onMemoryCompact: (scope, request) => {
      compactCalls.push({ scope, request });
      restoreBottom(true);
    },
    restoreBottom,
  });

  return {
    compactCalls,
    controller,
    restoreCalls,
    showCalls,
    input: (data: string) => tui.getFocus()?.handleInput?.(data),
    render: () => layout.render(80, 24).map(stripAnsi),
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
