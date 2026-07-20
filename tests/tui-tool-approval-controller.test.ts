import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import { ContentViewerController } from "../src/tui/app/content-viewer-controller";
import { ToolApprovalController } from "../src/tui/app/tool-approval-controller";
import { type Editor, Transcript } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";
import type { Component, Tui } from "../src/tui/runtime";

const DIVIDER = "─".repeat(80);

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tool approval controller", () => {
  test("replaces the editor while approval is active and restores it after a decision", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: new LinesComponent(["transcript"]),
      bottom: editor,
    });
    const tui = createTuiStub();
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
      onApprovalRequired: (toolName) => {
        shownTools.push(toolName);
      },
    });

    const result = controller.request(createToolCall(), undefined);

    expect(tui.getFocus()).toBe(controller.activePrompt);
    expect(controller.activePrompt).toBeDefined();
    expect(shownTools).toEqual(["bash"]);
    expect(layout.render(80).join("\n")).toContain("Allow agent to run bash?");
    expect(layout.render(80)).not.toContain("editor");

    controller.activePrompt?.handleInput?.("\r");
    await expect(result).resolves.toEqual({ type: "continue" });
    expect(layout.render(80).map(stripAnsi).slice(0, 3)).toEqual(["transcript", DIVIDER, "editor"]);
    expect(tui.getFocus()).toBe(editor);
  });

  test("keeps approval pending while another bottom component is active", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: new LinesComponent(["transcript"]),
      bottom: editor,
    });
    const tui = createTuiStub();
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
      onApprovalRequired: (toolName) => {
        shownTools.push(toolName);
      },
    });
    const viewer = new ContentViewerController({
      layout,
      transcript: new Transcript(),
      tui,
      restoreBottom: (focus) => {
        const bottom = controller.activePrompt ?? editor;

        layout.showBottom(bottom);
        if (focus) {
          tui.setFocus(bottom);
        }
      },
    });

    viewer.open({
      title: "Tool result",
      render: () => ["tool result viewer"],
    });
    const result = controller.request(createToolCall(), undefined);

    expect(controller.activePrompt).toBeDefined();
    expect(shownTools).toEqual(["bash"]);
    expect(layout.render(80).join("\n")).toContain("tool result viewer");
    expect(layout.render(80).join("\n")).not.toContain("Allow agent to run bash?");

    viewer.close();

    expect(tui.getFocus()).toBe(controller.activePrompt);
    expect(layout.render(80).join("\n")).toContain("Allow agent to run bash?");

    controller.activePrompt?.handleInput?.("\r");
    await expect(result).resolves.toEqual({ type: "continue" });
    expect(layout.render(80).map(stripAnsi).slice(0, 3)).toEqual(["transcript", DIVIDER, "editor"]);
  });

  test("resolves MCP provenance for the approval component", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: new LinesComponent(["transcript"]),
      bottom: editor,
    });
    const tui = createTuiStub();
    const controller = new ToolApprovalController({
      config: { mode: "unless_trusted" },
      approvals: {
        version: 2,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
      editor,
      layout,
      tui,
      resolveToolSource: (toolName) =>
        toolName === "github_create_issue"
          ? { kind: "mcp", serverId: "github", remoteToolName: "create_issue" }
          : undefined,
      onApprovalRequired: () => {},
    });

    const result = controller.request(
      {
        type: "tool_call",
        id: "call_2",
        name: "github_create_issue",
        args: { title: "Bug" },
      },
      undefined,
    );
    const rendered = layout.render(80).map(stripAnsi).join("\n");

    expect(rendered).toContain("Allow MCP tool?");
    expect(rendered).toContain("Server: github");
    expect(rendered).toContain("Tool: create_issue");
    expect(rendered).toContain('"title": "Bug"');

    controller.activePrompt?.handleInput?.("\r");
    await expect(result).resolves.toEqual({ type: "continue" });
  });
});

function createToolCall() {
  return {
    type: "tool_call" as const,
    id: "call_1",
    name: "bash",
    args: {
      command: "rm notes.txt",
    },
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
