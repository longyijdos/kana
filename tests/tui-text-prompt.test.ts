import { describe, expect, test } from "bun:test";
import { TextPrompt } from "../src/tui/components";
import { color, stripAnsi } from "../src/tui/render";
import { CURSOR_MARKER, stripCursorMarker } from "../src/tui/runtime";
import { tuiTheme } from "../src/tui/theme";

describe("text prompt", () => {
  test("renders a title and editable input without a status line", () => {
    const prompt = new TextPrompt({
      title: "Compaction request (optional)",
      placeholder: "No additional request",
      onSubmit: () => {},
      onCancel: () => {},
    });

    const rendered = prompt.render(40, 8);
    const visible = rendered.map((line) => stripAnsi(stripCursorMarker(line)));

    expect(visible[0]).toBe("Compaction request (optional)");
    expect(rendered[0]).toBe(color("Compaction request (optional)", tuiTheme.bottomTitle));
    expect(visible.some((line) => line.includes("> No additional request"))).toBe(true);
    expect(rendered.filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(1);
    expect(visible.some((line) => line.includes("idle"))).toBe(false);
  });

  test("edits on grapheme boundaries and submits with enter", () => {
    const submitted: string[] = [];
    const prompt = new TextPrompt({
      title: "Request",
      initialValue: "A👨‍👩‍👧‍👦B",
      onSubmit: (value) => submitted.push(value),
      onCancel: () => {},
    });

    prompt.handleInput("\x1b[D");
    prompt.handleInput("\x7f");
    prompt.handleInput("\r");

    expect(submitted).toEqual(["AB"]);
  });

  test("normalizes fragmented bracketed paste and supports explicit newlines", () => {
    const submitted: string[] = [];
    const prompt = new TextPrompt({
      title: "Request",
      onSubmit: (value) => submitted.push(value),
      onCancel: () => {},
    });

    prompt.handleInput("\x1b[200~first\r\n");
    prompt.handleInput("second\x1b[201~");
    prompt.handleInput("\x1b[13;2u");
    prompt.handleInput("third");
    prompt.handleInput("\r");

    expect(submitted).toEqual(["first\nsecond\nthird"]);
  });

  test("allows an empty submission and cancels with escape", () => {
    const submitted: string[] = [];
    let cancelled = false;
    const prompt = new TextPrompt({
      title: "Request",
      onSubmit: (value) => submitted.push(value),
      onCancel: () => {
        cancelled = true;
      },
    });

    prompt.handleInput("\r");
    prompt.handleInput("\x1b");

    expect(submitted).toEqual([""]);
    expect(cancelled).toBe(true);
  });

  test("keeps the cursor visible within a short available height", () => {
    const prompt = new TextPrompt({
      title: "Request",
      initialValue: "one two three four five six seven",
      onSubmit: () => {},
      onCancel: () => {},
    });

    const rendered = prompt.render(16, 4);

    expect(rendered).toHaveLength(4);
    expect(rendered.filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(1);
    expect(stripAnsi(stripCursorMarker(rendered.join("\n")))).not.toContain("one two");
  });
});
