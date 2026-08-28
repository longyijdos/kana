import { describe, expect, test } from "bun:test";
import { ContentViewer } from "../../src/tui/components";
import { stripAnsi, visibleWidth } from "../../src/tui/render";

describe("content viewer", () => {
  test("tool result viewer scrolls and pages with arrow keys", () => {
    const decisions: string[] = [];
    const viewer = new ContentViewer(
      {
        title: "Read AGENTS.md",
        render: () => Array.from({ length: 5 }, (_, index) => `line ${index + 1}`),
      },
      {
        onClose: () => {
          decisions.push("close");
        },
        visibleLimit: 3,
      },
    );

    expect(
      viewer
        .render(80)
        .map(stripAnsi)
        .some((line) => line.includes("line 1")),
    ).toBe(true);
    expect(
      viewer
        .render(80)
        .map(stripAnsi)
        .some((line) => line.includes("line 5")),
    ).toBe(false);
    expect(viewer.render(80).map(stripAnsi)).toContain("Lines 1-3 of 5");

    viewer.handleInput("\x1b[B");

    const oneLineDown = viewer.render(80).map(stripAnsi);

    expect(oneLineDown).toContain("Lines 2-4 of 5");
    expect(oneLineDown).toContain("... 1 lines above");

    viewer.handleInput(" ");

    expect(viewer.render(80).map(stripAnsi)).toContain("Lines 2-4 of 5");

    viewer.handleInput("\x1b[C");

    const pagedDown = viewer.render(80).map(stripAnsi);

    expect(pagedDown).toContain("Lines 3-5 of 5");
    expect(pagedDown).toContain("... 2 lines above");
    expect(pagedDown.some((line) => line.includes("line 5"))).toBe(true);

    viewer.handleInput("\x1b[D");

    expect(viewer.render(80).map(stripAnsi)).toContain("Lines 1-3 of 5");

    viewer.handleInput("\x1b");

    expect(decisions).toEqual(["close"]);
  });

  test("tool viewer navigates tools with brackets and keeps arrow paging", () => {
    const decisions: string[] = [];
    const viewer = new ContentViewer(
      {
        title: "Bash",
        render: () => ["one", "two", "three", "four", "five"],
      },
      {
        onClose: () => decisions.push("close"),
        onPrevious: () => decisions.push("previous"),
        onNext: () => decisions.push("next"),
        visibleLimit: 3,
      },
    );

    viewer.handleInput("[");
    viewer.handleInput("]");

    expect(decisions).toEqual(["previous", "next"]);

    viewer.render(80);
    viewer.handleInput("\x1b[C");

    expect(viewer.render(80).map(stripAnsi)).toContain("Lines 3-5 of 5");
  });

  test("tool result viewer shrinks its window for a short available height", () => {
    const viewer = new ContentViewer(
      {
        title: "Command output",
        render: () => [Array.from({ length: 5 }, (_, index) => `line ${index + 1}`).join("\n")],
      },
      {
        onClose: () => {},
      },
    );
    const rendered = viewer.render(80, 8).map(stripAnsi);

    expect(rendered).toContain("Lines 1-3 of 5");
    expect(rendered).toContain("  line 1");
    expect(rendered).toContain("  line 2");
    expect(rendered).toContain("  line 3");
    expect(rendered).not.toContain("  line 4");
    expect(rendered).toContain("... 2 lines below");
  });

  test("tool result viewer renders a multiline title as one truncated line", () => {
    const viewer = new ContentViewer(
      {
        title: "Ran printf table\n| 01 | macOS version | usable |\n| 02 | Shell | zsh |",
        render: () => ["output"],
      },
      { onClose: () => {} },
    );

    const rendered = viewer.render(32, 10);
    const title = stripAnsi(rendered[0] ?? "");

    expect(title.startsWith("Ran printf table | 01")).toBe(true);
    expect(title.endsWith("...")).toBe(true);
    expect(title).not.toContain("\n");
    expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(32);
  });
});
