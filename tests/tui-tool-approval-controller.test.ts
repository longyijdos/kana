import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import { ToolApprovalController } from "../src/tui/app/tool-approval-controller";
import { type Editor, StatusLine } from "../src/tui/components";
import type { Component, Tui } from "../src/tui/runtime";

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tool approval controller", () => {
  test("shows approval without stealing focus when the current view should keep it", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      transcript: new LinesComponent(["transcript"]),
      editor,
      status: new StatusLine("test-model"),
    });
    const tui = createTuiStub();
    const viewer = new LinesComponent(["tool result viewer"]);
    const shownTools: string[] = [];
    const controller = new ToolApprovalController({
      config: { mode: "always" },
      approvals: {
        version: 2,
        bash: {
          exactCommands: [],
          readOnlyCommands: [],
        },
      },
      editor,
      layout,
      tui,
      shouldPreserveFocus: () => true,
      onPromptShown: (toolName) => {
        shownTools.push(toolName);
      },
    });

    tui.setFocus(viewer);
    const result = controller.request(
      {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        args: {
          command: "rm notes.txt",
        },
      },
      undefined,
    );

    expect(tui.getFocus()).toBe(viewer);
    expect(controller.activePrompt).toBeDefined();
    expect(shownTools).toEqual(["bash"]);
    expect(layout.render(80).join("\n")).toContain("Allow agent to run bash?");

    controller.activePrompt?.handleInput?.("\r");
    await expect(result).resolves.toEqual({ type: "continue" });
    expect(tui.getFocus()).toBe(viewer);
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
