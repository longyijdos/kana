import { describe, expect, test } from "bun:test";
import { ChoicePrompt } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";

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

    expect(prompt.render(80).map(stripAnsi)).toEqual([
      "Delete session?",
      "Example session",
      "> No, keep it",
      "  Yes, delete",
    ]);
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
    expect(firstPage).toContain("> Allow once");
    expect(firstPage).toContain("  Deny");

    prompt.handleInput("\x1b[6~");

    const secondPage = prompt.render(40, 10).map(stripAnsi);

    expect(secondPage.length).toBeLessThanOrEqual(10);
    expect(secondPage).toContain("detail line 5");
    expect(secondPage).not.toContain("detail line 1");
    expect(secondPage).toContain("> Allow once");
  });

  test("selects with arrow keys and submits with enter", () => {
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

    prompt.handleInput("\x1b[B");
    prompt.handleInput("\r");

    expect(selected).toBe("yes");
  });
});
