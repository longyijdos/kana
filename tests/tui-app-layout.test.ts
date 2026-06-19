import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import type { Component } from "../src/tui/runtime";

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(): string[] {
    return this.lines;
  }
}

describe("tui app layout", () => {
  test("renders main content, inline prompt, overlay, editor, and status in app order", () => {
    const transcript = new LinesComponent(["transcript"]);
    const editor = new LinesComponent(["editor"]);
    const status = new LinesComponent(["status"]);
    const layout = new AppLayout({
      transcript,
      editor,
      status,
    });

    expect(layout.render(80)).toEqual(["transcript", "editor", "status"]);

    const toolViewer = new LinesComponent(["tool viewer"]);
    const prompt = new LinesComponent(["prompt"]);
    const overlay = new LinesComponent(["overlay"]);

    layout.showMain(toolViewer);
    layout.showInlinePrompt(prompt);
    layout.showOverlay(overlay);

    expect(layout.render(80)).toEqual(["tool viewer", "prompt", "editor", "overlay", "status"]);

    layout.clearInlinePrompt(prompt);
    layout.clearOverlay(overlay);
    layout.showTranscript();

    expect(layout.render(80)).toEqual(["transcript", "editor", "status"]);
  });
});
