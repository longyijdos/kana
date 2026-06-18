import { describe, expect, test } from "bun:test";
import { StatusLine } from "@/tui/components";
import { stripAnsi } from "@/tui/render";

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
  });

  test("keeps the abort hint while running", () => {
    const status = new StatusLine("deepseek/deepseek-v4-pro");

    status.update({
      phase: "thinking",
      running: true,
    });

    const rendered = stripAnsi(status.render(120)[0] ?? "");

    expect(rendered).toContain("Esc abort");
  });
});
