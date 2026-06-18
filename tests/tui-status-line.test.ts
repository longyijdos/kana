import { describe, expect, test } from "bun:test";
import { StatusLine } from "@/tui/components";
import { color, stripAnsi } from "@/tui/render";
import { tuiTheme } from "@/tui/theme";

describe("status line", () => {
  test("renders context usage next to the model", () => {
    const status = new StatusLine("deepseek/deepseek-v4-pro");

    status.update({
      phase: "idle",
      contextUsedPercent: 12,
      running: false,
    });

    const rendered = stripAnsi(status.render(120)[0] ?? "");

    expect(rendered).toStartWith("deepseek/deepseek-v4-pro | Context 12% used | idle");
    expect(rendered).not.toContain("Ctrl+C exit");
    expect(status.render(120)[0]).toContain(color("Context 12% used", tuiTheme.contextUsage));
  });

  test("does not render shortcut hints while running", () => {
    const status = new StatusLine("deepseek/deepseek-v4-pro");

    status.update({
      phase: "thinking",
      running: true,
    });

    const rendered = stripAnsi(status.render(120)[0] ?? "");

    expect(rendered).not.toContain("Esc abort");
  });
});
