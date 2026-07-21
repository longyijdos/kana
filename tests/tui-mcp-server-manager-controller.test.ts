import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import { McpServerManagerController } from "../src/tui/app/mcp-server-manager-controller";
import { Editor, Transcript } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";
import type { Component, Tui } from "../src/tui/runtime";

describe("MCP server manager controller", () => {
  test("saves and reloads once when an edited draft closes", () => {
    const harness = createHarness();

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\r");
    expect(harness.saved).toEqual([]);
    expect(harness.closed).toEqual([]);

    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.saved).toEqual([["filesystem", "github"]]);
    expect(harness.closed).toEqual([true]);
    expect(harness.tui.getFocus()).toBe(harness.editor);
    expect(harness.layout.isBottom(harness.editor)).toBe(true);
  });

  test("closes an unchanged draft without saving or reloading", () => {
    const harness = createHarness();

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.saved).toEqual([]);
    expect(harness.closed).toEqual([false]);
  });

  test("keeps the manager open when activation persistence fails", () => {
    const harness = createHarness(() => {
      throw new Error("activation write failed");
    });

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\r");
    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.controller.active).toBe(true);
    expect(harness.closed).toEqual([]);
    expect(harness.tui.getFocus()).not.toBe(harness.editor);
    expect(stripAnsi(harness.transcript.render(80).join("\n"))).toContain(
      "activation write failed",
    );
  });
});

function createHarness(save?: (serverIds: string[]) => void) {
  const editor = new Editor({ model: "test-model" });
  const transcript = new Transcript();
  const layout = new AppLayout({ main: transcript, bottom: editor });
  const tui = createTuiStub();
  const saved: string[][] = [];
  const closed: boolean[] = [];
  const controller = new McpServerManagerController({
    editor,
    layout,
    transcript,
    tui,
    loadServers: () => [
      { id: "filesystem", type: "stdio", command: "npx", args: ["-y"], enabled: false },
      { id: "github", type: "stdio", command: "github-mcp", args: [], enabled: true },
    ],
    saveEnabledServerIds: (serverIds) => {
      saved.push(serverIds);
      save?.(serverIds);
    },
    onClose: (changed) => closed.push(changed),
    updateStatus: () => {},
    restoreBottom: (focus) => {
      layout.showBottom(editor);
      if (focus) {
        tui.setFocus(editor);
      }
    },
  });

  return { controller, editor, transcript, layout, tui, saved, closed };
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
