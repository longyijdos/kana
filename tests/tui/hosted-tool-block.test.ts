import { describe, expect, test } from "bun:test";
import { HostedToolBlock } from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";

describe("hosted tool block", () => {
  test("freezes stopped hosted tool activity without an abort hint", () => {
    let now = 0;
    const block = new HostedToolBlock(
      {
        type: "hosted_tool",
        id: "web-search-active",
        name: "web_search",
        status: "in_progress",
      },
      () => now,
    );

    now = 2_000;
    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("◆ Searching the web (2s) (Esc to abort)");

    block.stopTimer();
    now = 7_000;

    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("◆ Searching the web (2s)");
  });

  test("renders canceled hosted tool activity as stopped", () => {
    const block = new HostedToolBlock({
      type: "hosted_tool",
      id: "web-search-canceled",
      name: "web_search",
      status: "canceled",
    });

    const rendered = block.render(80)[0] ?? "";

    expect(stripAnsi(rendered)).toBe("◆ Web search stopped");
    expect(rendered).toContain(color("◆ Web search stopped", tuiTheme.muted));
  });
});
