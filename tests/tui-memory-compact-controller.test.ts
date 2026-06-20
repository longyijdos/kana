import { describe, expect, test } from "bun:test";
import { MemoryCompactController } from "../src/tui/app/memory-compact-controller";
import { Editor, Transcript } from "../src/tui/components";
import { type Terminal, Tui } from "../src/tui/runtime";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;

  start(): void {}

  stop(): void {}

  write(): void {}

  notify(): void {}
}

describe("memory compact controller", () => {
  test("does not add memory commands to editor history", async () => {
    const editor = new Editor();
    const controller = new MemoryCompactController({
      editor,
      transcript: new Transcript(),
      tui: new Tui(new FakeTerminal()),
      setRunning() {},
      clearRunStatus() {},
      updateStatus() {},
      compactMemory: async () => [{ target: "workspace", outcome: "unchanged" }],
    });

    await controller.compact("workspace 记录已完成的工作");

    editor.render(80);
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("");
  });
});
