import { describe, expect, test } from "bun:test";
import { AppLayout } from "../src/tui/app/app-layout";
import type { Component } from "../src/tui/runtime";

class LinesComponent implements Component {
  lastAvailableHeight?: number;

  constructor(private readonly lines: string[]) {}

  render(_width: number, availableHeight?: number): string[] {
    this.lastAvailableHeight = availableHeight;
    return this.lines;
  }
}

describe("tui app layout", () => {
  test("renders main content, inline prompt, overlay, and the fused editor in app order", () => {
    const transcript = new LinesComponent(["transcript"]);
    const editor = new LinesComponent(["editor", "status"]);
    const layout = new AppLayout({
      transcript,
      editor,
    });

    expect(layout.render(80)).toEqual(["transcript", "editor", "status"]);

    const toolViewer = new LinesComponent(["tool viewer"]);
    const prompt = new LinesComponent(["prompt"]);
    const overlay = new LinesComponent(["overlay"]);

    layout.showMain(toolViewer);
    layout.showInlinePrompt(prompt);
    layout.showOverlay(overlay);

    expect(layout.render(80)).toEqual(["tool viewer", "prompt", "overlay", "editor", "status"]);

    layout.clearInlinePrompt(prompt);
    layout.clearOverlay(overlay);
    layout.showTranscript();

    expect(layout.render(80)).toEqual(["transcript", "editor", "status"]);
  });

  test("passes the available height hint to every active component", () => {
    const transcript = new LinesComponent(["transcript"]);
    const editor = new LinesComponent(["editor", "status"]);
    const prompt = new LinesComponent(["prompt"]);
    const overlay = new LinesComponent(["overlay"]);
    const layout = new AppLayout({ transcript, editor });

    layout.showInlinePrompt(prompt);
    layout.showOverlay(overlay);
    layout.render(80, 16);

    expect(
      [transcript, prompt, overlay, editor].map((component) => component.lastAvailableHeight),
    ).toEqual([16, 16, 16, 16]);
  });
});
