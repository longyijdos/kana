import { describe, expect, test } from "bun:test";
import { phaseForAgentEndReason } from "@/tui/app/status-phase";
import { Editor } from "@/tui/components";
import { color, stripAnsi } from "@/tui/render";
import { tuiTheme } from "@/tui/theme";

describe("prompt editor status line", () => {
  test("renders context usage next to the model", () => {
    const editor = new Editor({ model: "deepseek-v4-pro · high" });

    editor.updateStatus({
      phase: "idle",
      contextUsedPercent: 12,
      running: false,
    });

    const statusLine = editor.render(120).at(-1) ?? "";
    const rendered = stripAnsi(statusLine);

    expect(rendered).toStartWith("deepseek-v4-pro · high | Context ~12% used | idle");
    expect(rendered).not.toContain("Ctrl+C exit");
    expect(statusLine).toContain(color("Context ~12% used", tuiTheme.contextUsage));
  });

  test("keeps clean mode visible in the status line", () => {
    const editor = new Editor({
      cleanMode: true,
      model: "deepseek-v4-pro · high",
    });

    const rendered = stripAnsi(editor.render(120).at(-1) ?? "");

    expect(rendered).toStartWith("deepseek-v4-pro · high | clean | idle");
  });

  test("does not render shortcut hints while running", () => {
    const editor = new Editor({ model: "deepseek-v4-pro · high" });

    editor.updateStatus({
      phase: "thinking",
      running: true,
    });

    const rendered = stripAnsi(editor.render(120).at(-1) ?? "");

    expect(rendered).not.toContain("Esc abort");
  });

  test("renders a distinct turn-limit terminal phase", () => {
    const editor = new Editor({ model: "deepseek-v4-pro · high" });

    editor.updateStatus({
      phase: phaseForAgentEndReason("turn_limit"),
      running: false,
    });

    expect(stripAnsi(editor.render(120).at(-1) ?? "")).toContain("turn limit");
  });

  test("renders the context compaction phase", () => {
    const editor = new Editor({ model: "deepseek-v4-pro · high" });

    editor.updateStatus({
      phase: "compacting",
      running: true,
    });

    expect(stripAnsi(editor.render(120).at(-1) ?? "")).toContain("compacting");
  });

  test("hides while the slash command palette is open and returns after it closes", () => {
    const editor = new Editor({ model: "deepseek-v4-pro · high" });

    editor.setText("/");
    expect(stripAnsi(editor.render(120).join("\n"))).not.toContain("deepseek-v4-pro · high");

    editor.setText("/quit ");
    expect(stripAnsi(editor.render(120).join("\n"))).toContain("deepseek-v4-pro · high");
  });
});
