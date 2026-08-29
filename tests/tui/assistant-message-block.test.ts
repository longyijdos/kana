import { describe, expect, test } from "bun:test";
import { AssistantMessageBlock } from "../../src/tui/components";
import { color, stripAnsi, visibleWidth } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";
import { messageIdentityForTest } from "../helpers/messages";

describe("assistant message block", () => {
  test("renders assistant messages without leading blank lines in the text color", () => {
    const block = new AssistantMessageBlock();

    block.update({
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      content: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });

    const rendered = block.render(80)[0] ?? "";

    expect(stripAnsi(rendered)).toContain("hello");
    expect(rendered).toContain(color("hello", tuiTheme.markdownText));
  });

  test("renders hosted web actions separately with blank rows before following text", () => {
    const block = new AssistantMessageBlock();

    block.update({
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      content: [
        {
          type: "hosted_tool",
          id: "web-search-1",
          name: "web_search",
          status: "completed",
          action: {
            type: "search",
            query: "current release",
            queries: ["current release"],
          },
        },
        {
          type: "hosted_tool",
          id: "web-search-2",
          name: "web_search",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://example.com/releases",
          },
        },
        {
          type: "text",
          text: "Final answer with [citation](https://example.com/releases).",
        },
      ],
    });

    expect(block.render(100).map(stripAnsi)).toEqual([
      "◆ Searched the web",
      "  └ current release",
      "",
      "◆ Opened a web page",
      "  └ example.com/releases",
      "",
      "Final answer with citation (https://example.com/releases).",
    ]);
  });

  test("does not render assistant stop reasons as transcript content", () => {
    const block = new AssistantMessageBlock();

    block.update({
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      stopReason: "toolUse",
      content: [],
    });

    expect(block.render(80)).toEqual([]);
  });

  test("clears the working placeholder when working is no longer active", () => {
    const block = new AssistantMessageBlock();

    block.update({
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      content: [
        {
          type: "thinking",
          text: "internal reasoning",
        },
      ],
    });
    block.showWorking(true);

    const workingLine = block.render(80)[0] ?? "";

    expect(stripAnsi(workingLine)).toBe("Working (0s) (Esc to abort)");
    expect(workingLine).toContain(color(" (Esc to abort)", tuiTheme.shortcutHint));

    block.showWorking(false);

    expect(block.render(80)).toEqual([]);
  });

  test("invalidates assistant message cache when content changes", () => {
    const block = new AssistantMessageBlock();

    block.update({
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      content: [
        {
          type: "text",
          text: "before",
        },
      ],
    });

    expect(stripAnsi(block.render(80).join("\n"))).toContain("before");

    block.update({
      ...messageIdentityForTest("assistant"),
      role: "assistant",
      content: [
        {
          type: "text",
          text: "after",
        },
      ],
    });

    const rendered = stripAnsi(block.render(80).join("\n"));

    expect(rendered).toContain("after");
    expect(rendered).not.toContain("before");
  });

  test("finalizes a streaming table tail when the assistant message ends", () => {
    const block = new AssistantMessageBlock();
    const message = {
      ...messageIdentityForTest("assistant"),
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: ["| Key | Value |", "| --- | --- |", "| a | b |", "| growing-value | partial"].join(
            "\n",
          ),
        },
      ],
    };

    block.update(message, { complete: false });
    const streamingSeparator = block.render(40).map(stripAnsi)[1] ?? "";

    block.update(message, { complete: true });
    const completeSeparator = block.render(40).map(stripAnsi)[1] ?? "";

    expect(visibleWidth(streamingSeparator)).toBe(14);
    expect(visibleWidth(completeSeparator)).toBeGreaterThan(14);
  });
});
