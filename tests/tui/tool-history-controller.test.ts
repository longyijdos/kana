import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { ContentViewerController } from "../../src/tui/app/content-viewer-controller";
import { ToolHistoryController } from "../../src/tui/app/tool-history-controller";
import {
  type ContentViewer,
  type Editor,
  TextBlock,
  ToolCallBlock,
  type ToolHistoryPicker,
  Transcript,
} from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";
import { tuiTheme } from "../../src/tui/theme";

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

class EditorStub extends LinesComponent {
  clear(): void {}
}

describe("tool history controller", () => {
  test("lists every ToolCallBlock: short output, read, failed, and custom tools", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("short", "short output", "echo short"));
    transcript.addChild(
      completedBlock(
        "read",
        { path: "src/read.ts" },
        { path: "src/read.ts", content: "line", startLine: 1, endLine: 1, totalLines: 1 },
      ),
    );
    const failed = createBashBlock("failed", "boom", "boom");
    failed.updateResult({ error: "command crashed" }, true);
    transcript.addChild(failed);
    transcript.addChild(completedBlock("custom_lookup", { query: "x" }, { ok: true }));
    const { controller, tui } = createHarness(transcript);

    controller.open();

    const lines = pickerLines(tui);

    expect(lines).toEqual([
      "Tool history",
      "> custom_lookup",
      "  Bash  boom",
      "  Read  src/read.ts",
      "  Bash  echo short",
    ]);
  });

  test("never lists non-tool transcript children", () => {
    const transcript = new Transcript();
    transcript.addChild(new LinesComponent(["plain block content that must stay hidden"]));
    transcript.addChild(
      new TextBlock("a text block that must stay hidden", { color: tuiTheme.muted }),
    );
    transcript.addChild(createBashBlock("only", "out", "echo only"));
    const { controller, tui } = createHarness(transcript);

    controller.open();

    const lines = pickerLines(tui);

    expect(lines).toEqual(["Tool history", "> Bash  echo only"]);
    expect(lines.join("\n")).not.toContain("must stay hidden");
  });

  test("orders newest first with the newest selected by default", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("a", "a", "cmd-a"));
    transcript.addChild(createBashBlock("b", "b", "cmd-b"));
    transcript.addChild(createBashBlock("c", "c", "cmd-c"));
    const { controller, tui } = createHarness(transcript);

    controller.open();

    const lines = pickerLines(tui);

    expect(lines).toEqual(["Tool history", "> Bash  cmd-c", "  Bash  cmd-b", "  Bash  cmd-a"]);
  });

  test("uses the schema-owned summary for built-ins and none for unknown tools", () => {
    const transcript = new Transcript();
    transcript.addChild(
      completedBlock(
        "edit",
        { path: "src/app.ts", oldText: "old", newText: "new" },
        { path: "src/app.ts", replacements: 1, oldText: "old", newText: "new" },
      ),
    );
    transcript.addChild(
      completedBlock("glob", { pattern: "src/**/*.ts" }, { pattern: "src/**/*.ts", paths: [] }),
    );
    transcript.addChild(
      completedBlock("custom_lookup", { path: "/etc/passwd", command: "rm -rf /" }, { ok: true }),
    );
    const { controller, tui } = createHarness(transcript);

    controller.open();

    const lines = pickerLines(tui);

    expect(lines).toEqual([
      "Tool history",
      "> custom_lookup",
      "  Glob  src/**/*.ts",
      "  Edit  src/app.ts",
    ]);
    expect(lines.join("\n")).not.toContain("/etc/passwd");
    expect(lines.join("\n")).not.toContain("rm -rf");
  });

  test("enter opens the same tool detail inspector on the selected tool", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("a", "a", "cmd-a"));
    transcript.addChild(createBashBlock("b", "b", "cmd-b"));
    const { controller, tui, contentViewer, restoreCalls } = createHarness(transcript);

    controller.open();
    pressEnter(tui);

    expect(controller.active).toBe(false);
    expect(contentViewer.active).toBe(true);
    expect(restoreCalls).toEqual([]);

    const rendered = viewerLines(tui);
    expect(rendered[0]).toBe("Bash");
    expect(rendered.join("\n")).toContain("cmd-b");
    expect(rendered.join("\n")).not.toContain("cmd-a");
  });

  test("selecting a non-latest entry keeps bracket navigation in transcript order", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("a", "a", "cmd-a"));
    transcript.addChild(
      completedBlock(
        "read",
        { path: "beta.txt" },
        { path: "beta.txt", content: "x", startLine: 1, endLine: 1, totalLines: 1 },
      ),
    );
    transcript.addChild(completedBlock("custom_lookup", { query: "x" }, { ok: true }));
    const { controller, tui } = createHarness(transcript);

    controller.open();
    picker(tui).handleInput("\x1b[B");
    pressEnter(tui);

    expect(viewerTitle(tui)).toBe("Read");

    // [ moves back through transcript chronology: B -> A
    viewer(tui).handleInput("[");
    expect(viewerTitle(tui)).toBe("Bash");
    expect(viewerLines(tui).join("\n")).toContain("cmd-a");

    // ] moves forward again: A -> B -> C
    viewer(tui).handleInput("]");
    expect(viewerTitle(tui)).toBe("Read");
    viewer(tui).handleInput("]");
    expect(viewerTitle(tui)).toBe("custom_lookup");
  });

  test("picker to inspector never restores the editor in between", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("a", "a", "cmd-a"));
    const { controller, tui, layout, editor, restoreCalls } = createHarness(transcript);

    controller.open();
    pressEnter(tui);

    expect(restoreCalls).toEqual([]);
    expect(layout.isBottom(tui.getFocusedComponent() as Component)).toBe(true);
    expect(layout.render(80, 24).join("\n")).not.toContain("editor");
    expect(layout.render(80, 24).join("\n")).toContain("cmd-a");

    // The inspector's own close path restores the editor exactly once.
    viewer(tui).handleInput("\x1b");
    expect(restoreCalls).toEqual([true]);
    expect(layout.isBottom(editor as Component)).toBe(true);
    expect(tui.getFocus()).toBe(editor);
  });

  test("esc closes the picker and restores the editor", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("a", "a", "cmd-a"));
    const { controller, tui, layout, editor, restoreCalls } = createHarness(transcript);

    controller.open();
    picker(tui).handleInput("\x1b");

    expect(controller.active).toBe(false);
    expect(restoreCalls).toEqual([true]);
    expect(layout.isBottom(editor as Component)).toBe(true);
    expect(tui.getFocus()).toBe(editor);
  });

  test("empty history opens a lightweight empty picker and cancels without errors", () => {
    const transcript = new Transcript();
    transcript.addChild(new TextBlock("just a message", { color: tuiTheme.muted }));
    const { controller, tui, contentViewer, restoreCalls } = createHarness(transcript);

    controller.open();

    expect(controller.active).toBe(true);
    const lines = pickerLines(tui);
    expect(lines).toEqual(["Tool history", "No tool calls in this session."]);

    picker(tui).handleInput("\x1b");

    expect(controller.active).toBe(false);
    expect(contentViewer.active).toBe(false);
    expect(restoreCalls).toEqual([true]);
  });

  test("resize does not change membership, order, or the selected tool", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("a", "a", "cmd-a"));
    transcript.addChild(createBashBlock("b", "b", "cmd-b"));
    transcript.addChild(createBashBlock("c", "c", "cmd-c"));
    transcript.addChild(createBashBlock("d", "d", "cmd-d"));
    transcript.addChild(createBashBlock("e", "e", "cmd-e"));
    const { controller, tui } = createHarness(transcript);

    controller.open();
    picker(tui).handleInput("\x1b[B");
    picker(tui).handleInput("\x1b[B");

    const wide = pickerLines(tui, 120, 20);
    const narrow = pickerLines(tui, 40, 8);
    const tiny = pickerLines(tui, 40, 5);

    for (const lines of [wide, narrow, tiny]) {
      const selected = lines.find((line) => line.startsWith("> "));
      expect(selected).toBe("> Bash  cmd-c");
    }

    // Visible rows always follow the same newest-first order; a short
    // height only bounds the window, it never reorders or re-selects.
    const narrowRows = narrow.filter((line) => line.startsWith("> ") || line.startsWith("  "));
    expect(narrowRows).toEqual([
      "  Bash  cmd-e",
      "  Bash  cmd-d",
      "> Bash  cmd-c",
      "  Bash  cmd-b",
      "  Bash  cmd-a",
    ]);
    const tinyRows = tiny.filter((line) => line.startsWith("> ") || line.startsWith("  "));
    expect(tinyRows).toEqual(["  Bash  cmd-d", "> Bash  cmd-c"]);
  });

  test("keeps a long command and a long custom name on one truncated picker row", () => {
    const command = `python very_long_script.py --flag ${"x".repeat(150)}`;
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("long", "done", command));
    const longName = `custom_${"y".repeat(120)}`;
    transcript.addChild(completedBlock(longName, { query: "q" }, { ok: true }));
    const { controller, tui } = createHarness(transcript);

    controller.open();

    const pickerRows = pickerLines(tui, 48);
    for (const row of pickerRows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(48);
      expect(row).not.toContain("\n");
    }
    expect(pickerRows).toHaveLength(3);

    // Inspect the older bash entry; its full command must be recoverable.
    picker(tui).handleInput("\x1b[B");
    pressEnter(tui);

    const body = viewerLines(tui, 58);
    // Undo the viewer and context indentation so soft-wrapped rows
    // concatenate back into the original command text.
    const unwrapped = body.map((line) => line.replace(/^ {4}/, "")).join("");
    expect(unwrapped).toContain(command);
  });

  test("sanitizes terminal control sequences in built-in summaries", () => {
    const command = `echo safe\u001b[31mred\u001b[0m\u001b]0;owned\u0007tail`;
    const path = `src/\u001b[31mx\u001b[0m\nline\u0007.ts`;
    const pattern = `**/*\u001b]0;pwn\u0007`;
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("evil", "out", command));
    transcript.addChild(
      completedBlock(
        "read",
        { path },
        { path, content: "c", startLine: 1, endLine: 1, totalLines: 1 },
      ),
    );
    transcript.addChild(completedBlock("glob", { pattern }, { pattern, paths: [] }));
    const { controller, tui } = createHarness(transcript);

    controller.open();

    // Raw rows must not contain the attack sequences or bare control bytes;
    // the picker's own ANSI styling is the only escape output allowed.
    const raw = (tui.getFocusedComponent() as ToolHistoryPicker).render(80).join("\n");
    expect(raw).not.toContain("\u001b[31m");
    expect(raw).not.toContain("\u001b]0;");
    expect(raw).not.toContain("\u0007");
    expect(raw).not.toContain("owned");
    expect(raw).not.toContain("pwn");

    // Visible text survives, one row per entry, newline flattened.
    const rows = pickerLines(tui);
    expect(rows).toEqual([
      "Tool history",
      "> Glob  **/*",
      "  Read  src/x line.ts",
      "  Bash  echo saferedtail",
    ]);

    // The inspector keeps its own full-detail sanitization for the same data.
    // Newest-first selection starts on Glob; navigate down to the Bash row.
    picker(tui).handleInput("\x1b[B");
    picker(tui).handleInput("\x1b[B");
    pressEnter(tui);
    const body = viewerLines(tui);
    expect(body.join("\n")).not.toContain("\u001b[31m");
    expect(body.join("\n")).not.toContain("\u0007");
    expect(body.join("\n")).toContain("echo safe");
  });

  test("relinquish clears picker ownership without restoring the bottom", () => {
    const transcript = new Transcript();
    transcript.addChild(createBashBlock("only", "short output", "echo short"));
    const { controller, tui, contentViewer, layout, restoreCalls } = createHarness(transcript);

    controller.open();
    expect(controller.active).toBe(true);

    controller.relinquish();

    expect(controller.active).toBe(false);
    expect(restoreCalls).toEqual([]);
    // The picker is still the bottom view; the caller decides the replacement.
    expect(layout.isBottom(tui.getFocusedComponent() as Component)).toBe(true);

    // The Ctrl+O takeover then opens the latest tool directly, still
    // without any editor restore in between.
    expect(contentViewer.openLatest()).toBe(true);
    expect(restoreCalls).toEqual([]);
    expect(contentViewer.active).toBe(true);
    expect(viewerLines(tui).join("\n")).toContain("echo short");

    viewer(tui).handleInput("\x1b");
    expect(restoreCalls).toEqual([true]);
    expect(controller.active).toBe(false);
  });
});

function createHarness(transcript: Transcript): {
  controller: ToolHistoryController;
  tui: Tui & { getFocusedComponent: () => Component | undefined };
  contentViewer: ContentViewerController;
  layout: AppLayout;
  editor: LinesComponent;
  restoreCalls: boolean[];
} {
  const editor = new EditorStub(["editor"]);
  const restoreCalls: boolean[] = [];
  const restoreBottom = (focus: boolean): void => {
    restoreCalls.push(focus);
    layout.showBottom(editor);
    if (focus) {
      tui.setFocus(editor);
    }
  };
  const tui = createTuiStub();
  const layout = new AppLayout({
    main: transcript,
    bottom: editor,
  });
  const contentViewer = new ContentViewerController({
    layout,
    transcript,
    tui,
    restoreBottom,
  });
  const controller = new ToolHistoryController({
    editor: editor as unknown as Editor,
    layout,
    transcript,
    tui,
    contentViewer,
    restoreBottom,
  });

  return {
    controller,
    tui,
    contentViewer,
    layout,
    editor,
    restoreCalls,
  };
}

function pickerLines(
  tui: Tui & { getFocusedComponent: () => Component | undefined },
  width = 80,
  height?: number,
): string[] {
  return (tui.getFocusedComponent() as ToolHistoryPicker).render(width, height).map(stripAnsi);
}

function picker(
  tui: Tui & { getFocusedComponent: () => Component | undefined },
): ToolHistoryPicker {
  return tui.getFocusedComponent() as ToolHistoryPicker;
}

function pressEnter(tui: Tui & { getFocusedComponent: () => Component | undefined }): void {
  picker(tui).handleInput("\r");
}

function viewer(tui: Tui & { getFocusedComponent: () => Component | undefined }): ContentViewer {
  return tui.getFocusedComponent() as ContentViewer;
}

function viewerTitle(tui: Tui & { getFocusedComponent: () => Component | undefined }): string {
  return stripAnsi(viewer(tui).render(80)[0] ?? "");
}

function viewerLines(
  tui: Tui & { getFocusedComponent: () => Component | undefined },
  width = 80,
): string[] {
  return viewer(tui).render(width).map(stripAnsi);
}

function createBashBlock(id: string, stdout: string, command = id): ToolCallBlock {
  const block = new ToolCallBlock({
    type: "tool_call",
    id: `call_${id}`,
    name: "bash",
    args: { command },
  });
  block.updateResult({ command, exitCode: 0, stdout }, false);
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
