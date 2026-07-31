import { describe, expect, test } from "bun:test";
import { ChoicePrompt } from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";

describe("choice prompt", () => {
  test("renders the default selection", () => {
    const prompt = new ChoicePrompt({
      title: "Delete session?",
      detail: "Example session",
      options: [
        { value: "no", label: "No, keep it" },
        { value: "yes", label: "Yes, delete" },
      ],
      defaultValue: "no",
      onSelect: () => {},
    });

    const rendered = prompt.render(80);

    expect(rendered.map(stripAnsi)).toEqual([
      "Delete session?",
      "Example session",
      "> No, keep it",
      "  Yes, delete",
    ]);
    expect(rendered[0]).toBe(color("Delete session?", tuiTheme.bottomTitle));
    expect(rendered[2]).toBe(color("> No, keep it", tuiTheme.user));
  });

  test("wraps detail text instead of truncating it", () => {
    const prompt = new ChoicePrompt({
      title: "Run command?",
      detail: "bash -lc 'printf hello && printf world'",
      options: [
        { value: "yes", label: "Allow once" },
        { value: "no", label: "Deny" },
      ],
      defaultValue: "yes",
      onSelect: () => {},
    });

    const rendered = prompt.render(16).map(stripAnsi);

    expect(rendered).toEqual([
      "Run command?",
      "bash -lc 'printf",
      " hello && printf",
      " world'",
      "> Allow once",
      "  Deny",
    ]);
  });

  test("pages long detail within the available height while keeping options visible", () => {
    const prompt = new ChoicePrompt({
      title: "Run command?",
      detail: Array.from({ length: 10 }, (_, index) => `detail line ${index + 1}`).join("\n"),
      options: [
        { value: "yes", label: "Allow once" },
        { value: "no", label: "Deny" },
      ],
      defaultValue: "yes",
      onSelect: () => {},
    });

    const firstPage = prompt.render(40, 10).map(stripAnsi);

    expect(firstPage.length).toBeLessThanOrEqual(10);
    expect(firstPage).toContain("detail line 1");
    expect(firstPage).not.toContain("detail line 5");
    expect(firstPage).toContain("... 6 detail lines below");
    expect(firstPage).toContain("Left/Right page detail");
    expect(firstPage).toContain("> Allow once");
    expect(firstPage).toContain("  Deny");

    prompt.handleInput("\x1b[C");

    const secondPage = prompt.render(40, 10).map(stripAnsi);

    expect(secondPage.length).toBeLessThanOrEqual(10);
    expect(secondPage).toContain("detail line 5");
    expect(secondPage).not.toContain("detail line 1");
    expect(secondPage).toContain("> Allow once");

    prompt.handleInput("\x1b[D");
    expect(prompt.render(40, 10).map(stripAnsi)).toContain("detail line 1");

    prompt.handleInput("\x1b[6~");
    expect(prompt.render(40, 10).map(stripAnsi)).toContain("detail line 5");
  });

  test("selects with up and down without using left and right", () => {
    let selected: string | undefined;
    const prompt = new ChoicePrompt({
      title: "Delete session?",
      options: [
        { value: "no", label: "No, keep it" },
        { value: "yes", label: "Yes, delete" },
      ],
      defaultValue: "no",
      onSelect: (value) => {
        selected = value;
      },
    });

    prompt.handleInput("\x1b[C");
    prompt.handleInput("\x1b[B");
    prompt.handleInput("\r");

    expect(selected).toBe("yes");
  });

  test("cancels with escape when a cancel handler is provided", () => {
    let cancelled = false;
    const prompt = new ChoicePrompt({
      title: "Usage scope",
      options: [
        { value: "session", label: "Session" },
        { value: "project", label: "Project" },
      ],
      defaultValue: "session",
      onSelect: () => {},
      onCancel: () => {
        cancelled = true;
      },
    });

    prompt.handleInput("\x1b");

    expect(cancelled).toBe(true);
  });
});
