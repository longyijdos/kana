import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { ContentViewerController } from "../../src/tui/app/content-viewer-controller";
import { ToolApprovalController } from "../../src/tui/app/tool-approval-controller";
import { type Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

const DIVIDER = "─".repeat(80);

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tool approval controller", () => {
  test("offers user tasks in never mode and returns a normal declined result", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({ main: new LinesComponent(["transcript"]), bottom: editor });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    const controller = new ToolApprovalController({
      config: { mode: "never" },
      approvals: { version: 2, bash: { exactCommands: [], readOnlyCommands: [] } },
      addTrustedBashCommand: createTrustedCommandAdder(),
      editor,
      bottomArea,
      tui,
      onApprovalRequired: () => {},
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);
    const call = {
      type: "tool_call" as const,
      id: "task-call",
      name: "delegate_user_task",
      args: { task: "Check the screenshot." },
    };

    const declined = controller.request(call, undefined);
    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Accept task");
    controller.activePrompt?.handleInput?.("\r");
    await expect(declined).resolves.toEqual({
      type: "return",
      result: {
        content: "User declined the task. Complete it yourself.",
        result: { status: "declined" },
      },
    });

    const accepted = controller.request(call, undefined);
    controller.activePrompt?.handleInput?.("\x1b[A");
    controller.activePrompt?.handleInput?.("\r");
    await expect(accepted).resolves.toEqual({ type: "continue" });
  });

  test("temporarily overrides and resets the configured mode", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: new LinesComponent(["transcript"]),
      bottom: editor,
    });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    const controller = new ToolApprovalController({
      config: { mode: "unless_trusted" },
      approvals: {
        version: 2,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
      addTrustedBashCommand: createTrustedCommandAdder(),
      editor,
      bottomArea,
      tui,
      onApprovalRequired: () => {},
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);
    const trustedRead = {
      type: "tool_call" as const,
      id: "call_read",
      name: "read",
      args: { path: "README.md" },
    };

    await expect(controller.request(trustedRead, undefined)).resolves.toEqual({
      type: "continue",
    });

    controller.setTemporaryMode("always");
    const approval = controller.request(trustedRead, undefined);

    expect(controller.mode).toBe("always");
    expect(controller.activePrompt).toBeDefined();
    controller.activePrompt?.handleInput?.("\r");
    await expect(approval).resolves.toEqual({ type: "continue" });

    controller.setTemporaryMode("never");
    await expect(controller.request(createToolCall(), undefined)).resolves.toEqual({
      type: "continue",
    });
    expect(controller.activePrompt).toBeUndefined();
    expect(controller.resetTemporaryMode()).toBe("never");
    expect(controller.mode).toBe("unless_trusted");
  });

  test("replaces the editor while approval is active and restores it after a decision", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: new LinesComponent(["transcript"]),
      bottom: editor,
    });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
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
      addTrustedBashCommand: createTrustedCommandAdder(),
      editor,
      bottomArea,
      tui,
      onApprovalRequired: (toolName) => {
        shownTools.push(toolName);
      },
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);

    const result = controller.request(createToolCall(), undefined);

    expect(tui.getFocus()).toBe(controller.activePrompt);
    expect(controller.activePrompt).toBeDefined();
    expect(shownTools).toEqual(["bash"]);
    expect(layout.render(80).join("\n")).toContain("Allow Kana to run bash?");
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
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
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
      addTrustedBashCommand: createTrustedCommandAdder(),
      editor,
      bottomArea,
      tui,
      onApprovalRequired: (toolName) => {
        shownTools.push(toolName);
      },
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);
    const viewer = new ContentViewerController({
      bottomArea,
      transcript: new Transcript(),
    });

    viewer.open({
      title: "Tool result",
      render: () => ["tool result viewer"],
    });
    const result = controller.request(createToolCall(), undefined);

    expect(controller.activePrompt).toBeDefined();
    expect(shownTools).toEqual(["bash"]);
    expect(layout.render(80).join("\n")).toContain("tool result viewer");
    expect(layout.render(80).join("\n")).not.toContain("Allow Kana to run bash?");

    viewer.close();

    expect(tui.getFocus()).toBe(controller.activePrompt);
    expect(layout.render(80).join("\n")).toContain("Allow Kana to run bash?");

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
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    const controller = new ToolApprovalController({
      config: { mode: "unless_trusted" },
      approvals: {
        version: 2,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
      addTrustedBashCommand: createTrustedCommandAdder(),
      editor,
      bottomArea,
      tui,
      resolveToolSource: (call) =>
        call.name === "mcp_call"
          ? { kind: "mcp", serverId: "github", remoteToolName: "create_issue" }
          : undefined,
      onApprovalRequired: () => {},
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);

    const result = controller.request(
      {
        type: "tool_call",
        id: "call_2",
        name: "mcp_call",
        args: { server: "github", tool: "create_issue", arguments: { title: "Bug" } },
      },
      undefined,
    );
    const rendered = layout.render(80).map(stripAnsi).join("\n");

    expect(rendered).toContain("Allow Kana to use MCP tool?");
    expect(rendered).toContain("Server");
    expect(rendered).toContain("  github");
    expect(rendered).toContain("Tool");
    expect(rendered).toContain("  create_issue");
    expect(rendered).toContain("Arguments");
    expect(rendered).toContain("Left/Right page detail");

    // The complete arguments stay recoverable through detail paging.
    for (let page = 0; page < 3; page += 1) {
      controller.activePrompt?.handleInput?.("\x1b[C");
    }
    expect(layout.render(80).map(stripAnsi).join("\n")).toContain('"title": "Bug"');

    controller.activePrompt?.handleInput?.("\r");
    await expect(result).resolves.toEqual({ type: "continue" });
  });

  test("queues concurrent requests in order and keeps their subagent identity", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: new LinesComponent(["transcript"]),
      bottom: editor,
    });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    const controller = new ToolApprovalController({
      config: { mode: "always" },
      approvals: {
        version: 2,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
      addTrustedBashCommand: createTrustedCommandAdder(),
      editor,
      bottomArea,
      tui,
      onApprovalRequired: () => {},
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);

    const first = controller.request(createToolCall("call_first"), undefined, {
      id: "agent_first",
      label: "explorer · first",
      kind: "subagent",
      profileName: "explorer",
    });
    const second = controller.request(createToolCall("call_second"), undefined, {
      id: "agent_second",
      label: "worker · second",
      kind: "subagent",
      profileName: "worker",
    });

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Allow explorer to run bash?");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("Allow worker to run bash?");
    controller.activePrompt?.handleInput?.("\r");
    await expect(first).resolves.toEqual({ type: "continue" });

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Allow worker to run bash?");
    controller.activePrompt?.handleInput?.("\r");
    await expect(second).resolves.toEqual({ type: "continue" });
    expect(tui.getFocus()).toBe(editor);
  });

  test("Shift+Tab allows the current call and queued ordinary calls but still asks about user tasks", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({ main: new LinesComponent(["transcript"]), bottom: editor });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    const savedCommands: string[] = [];
    const controller = new ToolApprovalController({
      config: { mode: "always" },
      approvals: { version: 2, bash: { exactCommands: [], readOnlyCommands: [] } },
      addTrustedBashCommand: (command) => {
        savedCommands.push(command);
        return createTrustedCommandAdder()(command);
      },
      editor,
      bottomArea,
      tui,
      onApprovalRequired: () => {},
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);

    const first = controller.request(createToolCall("first"), undefined);
    const second = controller.request(createToolCall("second"), undefined);
    const task = controller.request(
      {
        type: "tool_call",
        id: "task",
        name: "delegate_user_task",
        args: { task: "Review the result." },
      },
      undefined,
    );
    const fourth = controller.request(createToolCall("fourth"), undefined);

    controller.activePrompt?.handleInput?.("\x1b[Z");
    await expect(first).resolves.toEqual({ type: "continue" });
    await expect(second).resolves.toEqual({ type: "continue" });
    expect(controller.mode).toBe("never");
    expect(savedCommands).toEqual([]);
    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Review the result.");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("Shift+Tab");

    controller.activePrompt?.handleInput?.("\x1b[Z");
    expect(controller.activePrompt).toBeDefined();
    controller.activePrompt?.handleInput?.("\r");
    await expect(task).resolves.toMatchObject({ type: "return" });
    await expect(fourth).resolves.toEqual({ type: "continue" });
    expect(controller.activePrompt).toBeUndefined();
    expect(tui.getFocus()).toBe(editor);
  });

  test("uses a persisted local trust decision for later requests", async () => {
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: new LinesComponent(["transcript"]),
      bottom: editor,
    });
    const tui = createTuiStub();
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    const savedCommands: string[] = [];
    const controller = new ToolApprovalController({
      config: { mode: "unless_trusted" },
      approvals: {
        version: 2,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
      addTrustedBashCommand: (command) => {
        savedCommands.push(command);
        return {
          version: 2,
          bash: { exactCommands: [...savedCommands], readOnlyCommands: [] },
        };
      },
      editor,
      bottomArea,
      tui,
      onApprovalRequired: () => {},
    });
    bottomArea.setFallback(() => controller.activePrompt ?? editor);

    const first = controller.request(createToolCall(), undefined);
    controller.activePrompt?.handleInput?.("\x1b[B");
    controller.activePrompt?.handleInput?.("\r");

    await expect(first).resolves.toEqual({ type: "continue" });
    expect(savedCommands).toEqual(["rm notes.txt"]);
    await expect(controller.request(createToolCall("call_2"), undefined)).resolves.toEqual({
      type: "continue",
    });
    expect(controller.activePrompt).toBeUndefined();
  });
});

function createTrustedCommandAdder() {
  return (command: string) => ({
    version: 2 as const,
    bash: { exactCommands: [command], readOnlyCommands: [] },
  });
}

function createToolCall(id = "call_1") {
  return {
    type: "tool_call" as const,
    id,
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
