import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { ContentViewerController } from "../../src/tui/app/content-viewer-controller";
import {
  type ContentViewer,
  type Editor,
  ToolCallBlock,
  Transcript,
} from "../../src/tui/components";
import { stripAnsi, stripTerminalControlSequences, visibleWidth } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tool detail inspector controller", () => {
  test("opens the latest tool even when its output is short and not omitted", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("first", longOutput("first")));
    transcript.addChild(createBashBlock("second", "short output"));
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const rendered = viewerLines(tui);
    expect(rendered[0]).toBe("Bash");
    expect(rendered.join("\n")).toContain("second");
    expect(rendered.join("\n")).toContain("short output");
    expect(rendered.join("\n")).not.toContain("Ran first");
  });

  test("opens a read tool that never had an expandable result", () => {
    const transcript = new Transcript();
    transcript.addChild(
      completedBlock(
        "read",
        { path: "src/read.ts" },
        {
          path: "src/read.ts",
          content: "line 1\nline 2",
          startLine: 1,
          endLine: 2,
          totalLines: 9,
        },
      ),
    );
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const rendered = viewerLines(tui);
    expect(rendered[0]).toBe("Read");
    expect(rendered.join("\n")).toContain("src/read.ts");
    expect(rendered.join("\n")).toContain("src/read.ts:1-2 of 9");
    // The read result renderer keeps its summary-only semantics: the actual
    // file content must not be replayed by the inspector.
    expect(rendered.join("\n")).not.toContain("line 2");
  });

  test("opens the newest running tool without a final result", () => {
    const transcript = new Transcript();
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_running",
      name: "bash",
      args: { command: "bun test --watch" },
    });
    block.markExecutionStarted();
    transcript.addChild(block);
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const rendered = viewerLines(tui).join("\n");
    expect(rendered).toContain("Command");
    expect(rendered).toContain("bun test --watch");
    expect(rendered).toContain("Status");
    expect(rendered).toContain("Running");
  });

  test("shows partial output while the inspected tool is still running", () => {
    const transcript = new Transcript();
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_partial",
      name: "bash",
      args: { command: "bun test" },
    });
    block.markExecutionStarted();
    block.updatePartialResult("partial output text");
    transcript.addChild(block);
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const rendered = viewerLines(tui).join("\n");
    expect(rendered).toContain("partial output text");
    expect(rendered).toContain("Running");
  });

  test("opens a canceled tool without a final result and reports its status", () => {
    const transcript = new Transcript();
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_canceled",
      name: "bash",
      args: { command: "bun test" },
    });
    block.markExecutionStarted();
    block.markCanceled();
    transcript.addChild(block);
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const rendered = viewerLines(tui).join("\n");
    expect(rendered).toContain("Status");
    expect(rendered).toContain("Canceled");
  });

  test("reflects updated arguments and partial output while the inspector stays open", () => {
    const transcript = new Transcript();
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_live",
      name: "bash",
      args: { command: "bun test" },
    });
    block.markExecutionStarted();
    transcript.addChild(block);
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    block.updateArgs({ command: "bun test --watch" });
    block.updatePartialResult("streamed output");

    const rendered = viewerLines(tui).join("\n");
    expect(rendered).toContain("bun test --watch");
    expect(rendered).toContain("streamed output");
  });

  test("keeps a long bash command out of the fixed title and soft-wraps it in the body", () => {
    const command = `python some_very_long_command.py --foo ${"x".repeat(120)} --bar value`;
    const block = createBashBlock("long", "done", command);
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const viewer = tui.getFocusedComponent() as ContentViewer;
    const rendered = viewer.render(60).map(stripAnsi);

    expect(rendered[0]).toBe("Bash");
    expect(rendered[0]).not.toContain("python");
    expect(rendered.every((line) => visibleWidth(line) <= 60)).toBe(true);

    const raw = block.getToolDetailView().render(58).map(stripAnsi);

    expect(raw.every((line) => visibleWidth(line) <= 58)).toBe(true);
    expect(raw.map((line) => line.replace(/^ {2}/, "")).join("")).toContain(command);
  });

  test("navigates previous and next across every tool call", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("alpha", "a output", "echo alpha"));
    transcript.addChild(
      completedBlock(
        "read",
        { path: "beta.txt" },
        { path: "beta.txt", content: "x", startLine: 1, endLine: 1, totalLines: 1 },
      ),
    );
    transcript.addChild(completedBlock("gamma_tool", { query: "anything" }, { ok: true }));
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);
    expect(viewerTitle(tui)).toBe("gamma_tool");

    expect(controller.showPreviousTool()).toBe(true);
    expect(viewerTitle(tui)).toBe("Read");
    expect(viewerLines(tui).join("\n")).toContain("beta.txt");

    expect(controller.showPreviousTool()).toBe(true);
    expect(viewerTitle(tui)).toBe("Bash");
    expect(viewerLines(tui).join("\n")).toContain("echo alpha");

    // Oldest boundary: no wrap-around.
    expect(controller.showPreviousTool()).toBe(false);
    expect(viewerTitle(tui)).toBe("Bash");

    expect(controller.showNextTool()).toBe(true);
    expect(viewerTitle(tui)).toBe("Read");

    // Newest boundary: no wrap-around.
    expect(controller.showNextTool()).toBe(true);
    expect(viewerTitle(tui)).toBe("gamma_tool");
    expect(controller.showNextTool()).toBe(false);
  });

  test("starts each navigated tool from the top with a fresh viewport", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("alpha", longOutput("alpha", 30)));
    transcript.addChild(createBashBlock("beta", longOutput("beta", 40)));
    const { controller, tui } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    let viewer = tui.getFocusedComponent() as ContentViewer;
    viewer.render(80);
    viewer.handleInput("\x1b[B");
    viewer.handleInput("\x1b[B");

    expect(viewer.render(80).map(stripAnsi)).toContain("... 2 lines above");

    expect(controller.showPreviousTool()).toBe(true);

    viewer = tui.getFocusedComponent() as ContentViewer;
    const fresh = viewer.render(80).map(stripAnsi);

    expect(fresh).toContain("Lines 1-18 of 40");
    expect(fresh).not.toContain("lines above");
  });

  test("returns false when the transcript has no tool calls", () => {
    const transcript = new Transcript();
    transcript.addChild(new LinesComponent(["hello"]));
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(false);
  });

  test("does not steal focus back from a newer prompt when closing", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("first", longOutput("first")));
    const { controller, tui, layout } = createController(transcript);
    const prompt = new LinesComponent(["approval prompt"]);

    expect(controller.openLatest()).toBe(true);
    layout.showBottom(prompt);
    tui.setFocus(prompt);

    controller.close();

    expect(tui.getFocus()).toBe(prompt);
    expect(layout.render(80)).toContain("approval prompt");
  });

  test("focuses a waiting prompt after closing the active viewer", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("first", longOutput("first")));
    const prompt = new LinesComponent(["approval prompt"]);
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const tui = createTuiStub();
    const layout = new AppLayout({
      main: transcript,
      bottom: editor,
    });
    const controller = new ContentViewerController({
      layout,
      transcript,
      tui,
      restoreBottom: (focus) => {
        layout.showBottom(prompt);
        if (focus) {
          tui.setFocus(prompt);
        }
      },
    });

    expect(controller.openLatest()).toBe(true);

    controller.close();

    expect(tui.getFocus()).toBe(prompt);
    expect(layout.render(80)).toContain("approval prompt");
  });

  test("recovers a long sanitized custom tool identity from the body", () => {
    const longName = `mcp\u001b]0;evil\u0007server_tool\n${"long_name_".repeat(12)}`;
    const expectedName = stripTerminalControlSequences(longName).replace(/[\r\n]+/g, " ");
    const deepValue = "z".repeat(60);
    const block = completedBlock(
      longName,
      { query: "find", nested: { deep: deepValue } },
      { ok: true, message: "m".repeat(40) },
    );
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const raw = block.getToolDetailView().render(50).map(stripAnsi);
    const body = raw.map((line) => line.replace(/^ {2}/, "")).join("");

    expect(body).toContain(expectedName);
    expect(body).toContain(`"deep": "${deepValue}"`);
    expect(raw.join("\n")).toContain('"ok": true');
  });

  test("shows write content once through the full renderer instead of duplicating it", () => {
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const block = completedBlock(
      "write",
      { path: "src/data.ts", content },
      {
        path: "src/data.ts",
        bytesWritten: Buffer.byteLength(content),
      },
    );
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const raw = block.getToolDetailView().render(58).map(stripAnsi);

    // Every content line appears exactly once, through the highlighted
    // write renderer; no plain-text Content section is duplicated.
    expect(raw.filter((line) => line.startsWith("+ "))).toHaveLength(30);
    expect(raw.filter((line) => line === "+ line 1")).toHaveLength(1);
    expect(raw).not.toContain("Content");
    expect(raw.every((line) => visibleWidth(line) <= 58)).toBe(true);
  });

  test("shows an edit diff once through the diff renderer instead of duplicating it", () => {
    const oldText = Array.from({ length: 30 }, (_, index) => `old line ${index + 1}`).join("\n");
    const newText = Array.from({ length: 30 }, (_, index) => `new line ${index + 1}`).join("\n");
    const block = completedBlock(
      "edit",
      { path: "src/app.ts", oldText, newText, replaceAll: true },
      { path: "src/app.ts", replacements: 1, oldText, newText },
    );
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const raw = block.getToolDetailView().render(58).map(stripAnsi);

    expect(raw.filter((line) => line.startsWith("- "))).toHaveLength(30);
    expect(raw.filter((line) => line.startsWith("+ "))).toHaveLength(30);
    expect(raw).not.toContain("Replace");
    expect(raw).not.toContain("With");
    expect(raw.join("\n")).toContain("Replace all");
  });

  test("keeps write content in context while the write is still running", () => {
    const content = "line 1\nline 2\nline 3";
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_write_running",
      name: "write",
      args: { path: "src/data.ts", content },
    });
    block.markExecutionStarted();
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const body = block.getToolDetailView().render(58).map(stripAnsi).join("\n");

    expect(body).toContain("Path");
    expect(body).toContain("src/data.ts");
    expect(body).toContain("Content");
    expect(body).toContain("line 2");
    expect(body).toContain("Status");
    expect(body).toContain("Running");
  });

  test("keeps edit replace and with in context while the edit is still running", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_edit_running",
      name: "edit",
      args: { path: "src/app.ts", oldText: "old text", newText: "new text" },
    });
    block.markExecutionStarted();
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const body = block.getToolDetailView().render(58).map(stripAnsi).join("\n");

    expect(body).toContain("Replace");
    expect(body).toContain("old text");
    expect(body).toContain("With");
    expect(body).toContain("new text");
    expect(body).toContain("Status");
    expect(body).toContain("Running");
  });

  test("keeps write content in context when a failed write reports only an error", () => {
    const content = "line 1\nline 2\nline 3";
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_write_failed",
      name: "write",
      args: { path: "src/data.ts", content },
    });
    block.updateResult({ error: "disk full" }, true);
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const body = block.getToolDetailView().render(58).map(stripAnsi).join("\n");

    expect(body).toContain("Content");
    expect(body).toContain("line 2");
    expect(body).toContain("Status");
    expect(body).toContain("Failed");
    expect(body).toContain("disk full");
  });

  test("keeps edit replace and with in context when a failed edit reports only an error", () => {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_edit_failed",
      name: "edit",
      args: { path: "src/app.ts", oldText: "old text", newText: "new text" },
    });
    block.updateResult({ error: "Text not found in file: src/app.ts" }, true);
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const body = block.getToolDetailView().render(58).map(stripAnsi).join("\n");

    expect(body).toContain("Replace");
    expect(body).toContain("old text");
    expect(body).toContain("With");
    expect(body).toContain("new text");
    expect(body).toContain("Status");
    expect(body).toContain("Failed");
    expect(body).toContain("Text not found");
  });

  test("keeps edit replace and with in context when a done result lacks old and new text", () => {
    // formatEditOutput recovers the diff only from result.oldText/newText;
    // without them the output renderer has nothing to show, so the inspector
    // must not drop the operation material either.
    const block = completedBlock(
      "edit",
      { path: "src/app.ts", oldText: "old text", newText: "new text" },
      { path: "src/app.ts", replacements: 1 },
    );
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const body = block.getToolDetailView().render(58).map(stripAnsi).join("\n");

    expect(body).toContain("Replace");
    expect(body).toContain("old text");
    expect(body).toContain("With");
    expect(body).toContain("new text");
  });

  test("keeps write content in context when a canceled write has no result", () => {
    const content = "line 1\nline 2";
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call_write_canceled",
      name: "write",
      args: { path: "src/data.ts", content },
    });
    block.markExecutionStarted();
    block.markCanceled();
    const transcript = new Transcript();
    transcript.addChild(block);
    const { controller } = createController(transcript);

    expect(controller.openLatest()).toBe(true);

    const body = block.getToolDetailView().render(58).map(stripAnsi).join("\n");

    expect(body).toContain("Content");
    expect(body).toContain("line 2");
    expect(body).toContain("Status");
    expect(body).toContain("Canceled");
  });
});

function createController(transcript: Transcript): {
  controller: ContentViewerController;
  tui: Tui & { getFocusedComponent: () => Component | undefined };
  layout: AppLayout;
  editor: LinesComponent;
} {
  const editor = new LinesComponent(["editor"]);
  const tui = createTuiStub();
  const layout = new AppLayout({
    main: transcript,
    bottom: editor,
  });
  const controller = new ContentViewerController({
    layout,
    transcript,
    tui,
    restoreBottom: (focus) => {
      layout.showBottom(editor);
      if (focus) {
        tui.setFocus(editor);
      }
    },
  });

  return {
    controller,
    tui,
    layout,
    editor,
  };
}

function viewerTitle(tui: Tui & { getFocusedComponent: () => Component | undefined }): string {
  return stripAnsi((tui.getFocusedComponent() as ContentViewer).render(80)[0] ?? "");
}

function viewerLines(tui: Tui & { getFocusedComponent: () => Component | undefined }): string[] {
  return (tui.getFocusedComponent() as ContentViewer).render(80).map(stripAnsi);
}

function createBashBlock(id: string, stdout: string, command = id): ToolCallBlock {
  const block = new ToolCallBlock({
    type: "tool_call",
    id: `call_${id}`,
    name: "bash",
    args: {
      command,
    },
  });

  block.updateResult(
    {
      command,
      exitCode: 0,
      stdout,
    },
    false,
  );

  return block;
}

function completedBlock(name: string, args: unknown, result: unknown): ToolCallBlock {
  const block = new ToolCallBlock({
    type: "tool_call",
    id: `call-${name}`,
    name,
    args,
  });
  block.updateResult(result, false);
  return block;
}

function longOutput(prefix: string, count = 10): string {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}`).join("\n");
}

function createTuiStub(): Tui & { getFocusedComponent: () => Component | undefined } {
  let focusedComponent: Component | undefined;

  return {
    requestRender: () => {},
    getFocus: () => focusedComponent,
    setFocus: (component: Component | undefined) => {
      focusedComponent = component;
    },
    getFocusedComponent: () => focusedComponent,
  } as unknown as Tui & { getFocusedComponent: () => Component | undefined };
}
