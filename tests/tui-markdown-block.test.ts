import { describe, expect, test } from "bun:test";
import { MarkdownBlock } from "../src/tui/components";
import { preloadSyntaxHighlighter } from "../src/tui/utils/syntax-highlighter";
import { color, stripAnsi, visibleWidth } from "../src/tui/render";
import { tuiTheme } from "../src/tui/theme";

describe("tui markdown block", () => {
  test("renders headings with bold styling", () => {
    const rendered = new MarkdownBlock("# Title", { color: "white" }).render(80);

    expect(stripAnsi(rendered[0] ?? "")).toBe("Title");
    expect(rendered[0]).toContain("\x1b[1m");
  });

  test("invalidates cached output when text changes", () => {
    const block = new MarkdownBlock("before", { color: "white" });

    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("before");

    block.setText("after");

    expect(stripAnsi(block.render(80)[0] ?? "")).toBe("after");
  });

  test("renders unordered list continuations with stable indentation", () => {
    const lines = new MarkdownBlock("- abcdef", { color: "white" }).render(5).map(stripAnsi);

    expect(lines).toEqual(["- abc", "  def"]);
  });

  test("renders unclosed fenced code blocks during streaming", () => {
    const lines = new MarkdownBlock("```ts\nconst value = 1").render(80).map(stripAnsi);

    expect(lines).toEqual(["    const value = 1"]);
  });

  test("renders fenced code blocks with shiki highlighting after preload", async () => {
    await preloadSyntaxHighlighter();

    const rendered = new MarkdownBlock("```ts\nconst value = 1\n```").render(80);

    expect(stripAnsi(rendered[0] ?? "")).toBe("    const value = 1");
    expect(rendered[0]).toContain("\x1b[38;2;");
  });

  test("renders inline code and bold without changing visible text", () => {
    const rendered = new MarkdownBlock("Use `bun test` for **checks**.", {
      color: "white",
    }).render(80);

    expect(stripAnsi(rendered[0] ?? "")).toBe("Use bun test for checks.");
    expect(rendered[0]).toContain("\x1b[1m");
    expect(rendered[0]).toContain(color("bun test", tuiTheme.markdownInlineCode));
  });

  test("renders combined and nested emphasis", () => {
    const rendered = new MarkdownBlock("这是***粗斜体***，还有：**前面粗体*里面斜体*后面粗体**", {
      color: "white",
    }).render(120);

    expect(stripAnsi(rendered[0] ?? "")).toBe("这是粗斜体，还有：前面粗体里面斜体后面粗体");
    expect(rendered[0]).toContain("\x1b[1m");
    expect(rendered[0]).toContain("\x1b[3m");
  });

  test("renders strikethrough without changing visible text", () => {
    const rendered = new MarkdownBlock("这是~~删除线~~。", {
      color: "white",
    }).render(80);

    expect(stripAnsi(rendered[0] ?? "")).toBe("这是删除线。");
    expect(rendered[0]).toContain("\x1b[9m");
  });

  test("renders italic without changing visible text", () => {
    const rendered = new MarkdownBlock("Use *care* and _focus_.", {
      color: "white",
    }).render(80);

    expect(stripAnsi(rendered[0] ?? "")).toBe("Use care and focus.");
    expect(rendered[0]).toContain("\x1b[3m");
  });

  test("leaves unclosed italic markers as plain text while streaming", () => {
    const rendered = new MarkdownBlock("Use *care", {
      color: "white",
    }).render(80);

    expect(stripAnsi(rendered[0] ?? "")).toBe("Use *care");
    expect(rendered[0]).not.toContain("\x1b[3m");
  });

  test("renders indented headings, nested quotes, task lists, and rules", () => {
    const rendered = new MarkdownBlock(
      ["    ## 标题", "    > > 嵌套引用", "    - [x] 已完成任务", "    ---"].join("\n"),
      { color: "white" },
    ).render(80);
    const plain = rendered.map(stripAnsi);

    expect(plain[0]).toBe("标题");
    expect(plain[1]).toBe("> > 嵌套引用");
    expect(plain[2]).toBe("    [x] 已完成任务");
    expect(plain[3]).toBe("----------------------------------------");
  });

  test("renders table rows, links, images, and inline html as terminal text", () => {
    const rendered = new MarkdownBlock(
      [
        "| 语言 | 类型 |",
        "|------|------|",
        "| Rust | 系统级 |",
        "[链接](https://example.com)",
        "![占位图](https://example.com/image.png)",
        "<kbd>Ctrl</kbd> + <kbd>C</kbd>",
      ].join("\n"),
      { color: "white" },
    ).render(120);
    const plain = rendered.map(stripAnsi);

    expect(plain).toEqual([
      "语言  类型",
      "Rust  系统级",
      "链接 (https://example.com)",
      "[image: 占位图] https://example.com/image.png",
      "[Ctrl] + [C]",
    ]);
  });

  test("wraps wide characters by visible terminal width", () => {
    const lines = new MarkdownBlock("- 你好世界", { color: "white" }).render(6);

    expect(lines.map(stripAnsi)).toEqual(["- 你好", "  世界"]);
    expect(lines.every((line) => visibleWidth(line) <= 6)).toBe(true);
  });
});
