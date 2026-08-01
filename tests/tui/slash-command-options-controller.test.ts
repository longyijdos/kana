import { describe, expect, test } from "bun:test";
import type { KanaToolApprovalMode } from "../../src/kana";
import { AppLayout } from "../../src/tui/app/app-layout";
import { SlashCommandOptionsController } from "../../src/tui/app/slash-command-options-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";
import { tuiTheme } from "../../src/tui/theme";

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

  test("changes approval mode directly when approvals remain enabled", () => {
    const harness = createHarness();

    harness.controller.openApproval();

    expect(harness.render()).toContain("Tool approval mode");
    expect(harness.render()).toContain("> Ask unless trusted");

    harness.input("\x1b[A");
    harness.input("\r");

    expect(harness.approvalCalls).toEqual(["always"]);
    expect(harness.controller.active).toBe(false);
    expect(harness.restoreCalls).toEqual([true]);
  });

  test("requires confirmation before disabling approvals", () => {
    const harness = createHarness();

    harness.controller.openApproval();
    harness.input("\x1b[B");
    harness.input("\r");

    expect(harness.render()).toContain("Disable tool approvals?");
    expect(harness.render()).toContain("> No, keep current mode");
    expect(harness.renderRaw()).toContain(color("Disable tool approvals?", tuiTheme.error));
    expect(harness.approvalCalls).toEqual([]);

    harness.input("\r");

    expect(harness.render()).toContain("Tool approval mode");
    expect(harness.approvalCalls).toEqual([]);

    harness.input("\x1b[B");
    harness.input("\r");
    harness.input("\x1b[B");
    harness.input("\r");

    expect(harness.approvalCalls).toEqual(["never"]);
    expect(harness.controller.active).toBe(false);
    expect(harness.restoreCalls).toEqual([true]);
  });
});

function createHarness() {
  const editor = new Editor({ model: "test-model" });
  const layout = new AppLayout({ main: new Transcript(), bottom: editor });
  const tui = createTuiStub();
  const compactCalls: Array<{ scope: string; request: string | undefined }> = [];
  const approvalCalls: string[] = [];
  let approvalMode: KanaToolApprovalMode = "unless_trusted";
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
    getApprovalMode: () => approvalMode,
    onApprovalModeSelect: (mode) => {
      approvalMode = mode;
      approvalCalls.push(mode);
      restoreBottom(true);
    },
    restoreBottom,
  });

  return {
    approvalCalls,
    compactCalls,
    controller,
    restoreCalls,
    showCalls,
    input: (data: string) => tui.getFocus()?.handleInput?.(data),
    render: () => layout.render(80, 24).map(stripAnsi),
    renderRaw: () => layout.render(80, 24),
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
