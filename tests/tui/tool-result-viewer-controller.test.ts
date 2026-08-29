import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { ContentViewerController } from "../../src/tui/app/content-viewer-controller";
import {
  type ContentViewer,
  type Editor,
  ToolCallBlock,
  Transcript,
} from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tool detail inspector controller", () => {
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

    expect(fresh).toContain("Lines 1-18 of 43");
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
      bottomArea: new BottomAreaController({ layout, tui, fallback: prompt }),
      transcript,
    });

    expect(controller.openLatest()).toBe(true);

    controller.close();

    expect(tui.getFocus()).toBe(prompt);
    expect(layout.render(80)).toContain("approval prompt");
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
    bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
    transcript,
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
