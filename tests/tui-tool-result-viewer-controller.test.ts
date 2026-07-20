import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import { ContentViewerController } from "../src/tui/app/content-viewer-controller";
import { type Editor, ToolCallBlock, Transcript } from "../src/tui/components";
import type { Component, Tui } from "../src/tui/runtime";

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tool result viewer controller", () => {
  test("opens the latest expandable tool when newer tools are not expandable", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("first", longOutput("first")));
    transcript.addChild(createBashBlock("second", "short output"));
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
      restoreBottom: createBottomRestorer(layout, tui, editor),
    });

    expect(controller.openLatest()).toBe(true);
    expect(layout.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))).toContain(
      "Ran first",
    );
  });

  test("opens the latest tool when its output is expandable", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("first", "short output"));
    transcript.addChild(createBashBlock("second", longOutput("second")));
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
      restoreBottom: createBottomRestorer(layout, tui, editor),
    });

    expect(controller.openLatest()).toBe(true);
    expect(layout.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))).toContain(
      "Ran second",
    );
  });

  test("does not steal focus back from a newer prompt when closing", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("first", longOutput("first")));
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: transcript,
      bottom: editor,
    });
    const tui = createTuiStub();
    const controller = new ContentViewerController({
      layout,
      transcript,
      tui,
      restoreBottom: createBottomRestorer(layout, tui, editor),
    });
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
    const editor = new LinesComponent(["editor"]) as unknown as Editor;
    const layout = new AppLayout({
      main: transcript,
      bottom: editor,
    });
    const prompt = new LinesComponent(["approval prompt"]);
    const tui = createTuiStub();
    const controller = new ContentViewerController({
      layout,
      transcript,
      tui,
      restoreBottom: createBottomRestorer(layout, tui, prompt),
    });

    expect(controller.openLatest()).toBe(true);

    controller.close();

    expect(tui.getFocus()).toBe(prompt);
    expect(layout.render(80)).toContain("approval prompt");
  });
});

function createBashBlock(command: string, stdout: string): ToolCallBlock {
  const block = new ToolCallBlock({
    type: "tool_call",
    id: `call_${command}`,
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

function longOutput(prefix: string): string {
  return Array.from({ length: 10 }, (_, index) => `${prefix} line ${index + 1}`).join("\n");
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

function createBottomRestorer(
  layout: AppLayout,
  tui: Tui,
  bottom: Component,
): (focus: boolean) => void {
  return (focus) => {
    layout.showBottom(bottom);
    if (focus) {
      tui.setFocus(bottom);
    }
  };
}
