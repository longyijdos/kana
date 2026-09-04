import { describe, expect, test } from "bun:test";
import { MarkdownBlock } from "../../src/tui/components";
import { CLOSE_TERMINAL_HYPERLINK, color, stripAnsi, visibleWidth } from "../../src/tui/render";
import { tuiTheme } from "../../src/tui/theme";
import { preloadSyntaxHighlighter } from "../../src/tui/utils/syntax-highlighter";

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

  test("rejects changing the Shiki theme after preload starts", async () => {
    await preloadSyntaxHighlighter();

    await expect(preloadSyntaxHighlighter("light-plus")).rejects.toThrow(
      "Syntax highlighting already uses tokyo-night; it cannot switch to light-plus at runtime.",
    );
  });

  test("renders Mermaid code blocks as themed Unicode diagrams", () => {
    const rendered = new MarkdownBlock(
      [
        "Before",
        "```mermaid",
        "flowchart LR",
        "  A[Start]:::highlight --> B[Done]",
        "```",
        "After",
      ].join("\n"),
    ).render(80);
    const plain = rendered.map(stripAnsi);

    expect(plain).toEqual([
      "Before",
      "┌───────┐    ┌──────┐",
      "│ Start ├───▶│ Done │",
      "└───────┘    └──────┘",
      "After",
    ]);
    expect(rendered.join("\n")).toContain(`\x1b[38;2;${tuiTheme.markdownHeading.join(";")}m`);
  });

  test("renders partial Mermaid while streaming and reports incomplete final diagrams", () => {
    const source = ["```mermaid", "flowchart LR", "  A[Start"].join("\n");
    const streaming = new MarkdownBlock(source, {
      complete: false,
      renderMermaid: true,
      trailingLineComplete: false,
    })
      .render(80)
      .map(stripAnsi);
    const complete = new MarkdownBlock(source, { renderMermaid: true }).render(80).map(stripAnsi);

    expect(streaming).toEqual(["┌───────┐", "│ Start │", "└───────┘"]);
    expect(streaming.join("\n")).not.toContain("Mermaid source restored");
    expect(complete.slice(0, 2)).toEqual(["    flowchart LR", "      A[Start"]);
    expect(complete.at(-1)).toBe(
      'Mermaid source restored: node "A": label is missing its closing `]`',
    );
  });

  test("falls back to Mermaid source when disabled, unsupported, or too wide", () => {
    const flowchart = ["```mermaid", "flowchart LR", "  A[Start] --> B[Done]", "```"].join("\n");
    const disabled = new MarkdownBlock(flowchart, { renderMermaid: false })
      .render(80)
      .map(stripAnsi);
    const narrow = new MarkdownBlock(flowchart).render(10).map(stripAnsi);
    const unsupported = new MarkdownBlock(["```mermaid", "pie", '  "Dogs" : 4', "```"].join("\n"))
      .render(80)
      .map(stripAnsi);

    expect(disabled).toEqual(["    flowchart LR", "      A[Start] --> B[Done]"]);
    expect(narrow.join("").replaceAll(/\s/g, "")).toBe("flowchartLRA[Start]-->B[Done]");
    expect(narrow.join("\n")).not.toContain("┌");
    expect(unsupported).toEqual(["    pie", '      "Dogs" : 4']);
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
        "<span>inline HTML</span><br>next",
      ].join("\n"),
      { color: "white" },
    ).render(120);
    const plain = rendered.map(stripAnsi);

    expect(plain).toEqual([
      " 语言    类型",
      "━━━━━━  ━━━━━━━━",
      " Rust    系统级",
      "链接 (https://example.com)",
      "[image: 占位图] https://example.com/image.png",
      "[Ctrl] + [C]",
      "inline HTMLnext",
    ]);
  });

  test("renders safe links with OSC 8 across Markdown block contexts", () => {
    const cases = [
      { source: "[Paragraph](https://example.com/paragraph)", visible: "Paragraph" },
      { source: "# [Heading](https://example.com/heading)", visible: "Heading" },
      { source: "- [List](https://example.com/list)", visible: "- List" },
      { source: "> [Quote](https://example.com/quote)", visible: "> Quote" },
    ];

    for (const { source, visible } of cases) {
      const rendered = new MarkdownBlock(source, { hyperlinks: true }).render(80);

      expect(rendered.map(stripAnsi)).toEqual([visible]);
      expect(rendered[0]).toContain("\x1b]8;;https://example.com/");
      expect(rendered[0]).toContain(CLOSE_TERMINAL_HYPERLINK);
    }
  });

  test("preserves inline styles inside terminal hyperlinks", () => {
    const rendered = new MarkdownBlock(
      "[**Bold** and *italic*](https://example.com/styles) [Email](mailto:test@example.com)",
      { hyperlinks: true },
    ).render(80);

    expect(rendered.map(stripAnsi)).toEqual(["Bold and italic Email"]);
    expect(rendered[0]).toContain("\x1b[1m");
    expect(rendered[0]).toContain("\x1b[3m");
    expect(rendered[0]).toContain("\x1b]8;;mailto:test@example.com\x1b\\");
  });

  test("falls back to visible destinations before wrapping", () => {
    const rendered = new MarkdownBlock("[OpenAI](https://example.com) tail", {
      hyperlinks: false,
    }).render(12);
    const plain = rendered.map(stripAnsi);

    expect(plain.join("")).toBe("OpenAI (https://example.com) tail");
    expect(rendered.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(rendered.join("")).not.toContain("\x1b]8;;");
  });

  test("closes and reopens hyperlinks around wrapped lines", () => {
    const rendered = new MarkdownBlock("[abcdefgh](https://example.com) tail", {
      hyperlinks: true,
    }).render(5);

    expect(rendered.map(stripAnsi)).toEqual(["abcde", "fgh t", "ail"]);
    for (const line of rendered.slice(0, 2)) {
      expect(countOccurrences(line, "\x1b]8;;https://example.com/\x1b\\")).toBe(1);
      expect(countOccurrences(line, CLOSE_TERMINAL_HYPERLINK)).toBe(1);
    }
    expect(rendered[2]).not.toContain("\x1b]8;;");
  });

  test("renders links inside table cells without changing table width", () => {
    const rendered = new MarkdownBlock(
      ["| Name | Link |", "| --- | --- |", "| Kana | [Repository](https://example.com) |"].join(
        "\n",
      ),
      { hyperlinks: true },
    ).render(30);
    const linkLine = rendered.find((line) => stripAnsi(line).includes("Repository"));

    expect(linkLine).toContain("\x1b]8;;https://example.com/\x1b\\");
    expect(stripAnsi(linkLine ?? "")).not.toContain("https://example.com");
    expect(rendered.every((line) => visibleWidth(line) <= 30)).toBe(true);
  });

  test("degrades unsafe destinations without emitting terminal controls", () => {
    const rendered = new MarkdownBlock(
      [
        "[JavaScript](javascript:alert(1))",
        "[Data](data:text/plain,hello)",
        "[Relative](../docs)",
        "[Injected](https://example.com/\x1b]8;;bad\x1b\\)",
      ].join(" "),
      { hyperlinks: true },
    ).render(200);

    expect(rendered.map(stripAnsi)).toEqual([
      "JavaScript (javascript:alert(1)) Data (data:text/plain,hello) Relative (../docs) Injected (https://example.com/)",
    ]);
    expect(rendered.join("")).not.toContain("\x1b]8;;");
  });

  test("keeps incomplete streamed links literal until they close", () => {
    const block = new MarkdownBlock("[OpenAI](https://example.com", {
      complete: false,
      hyperlinks: true,
      trailingLineComplete: false,
    });
    const partial = block.render(80);

    expect(partial.map(stripAnsi)).toEqual(["[OpenAI](https://example.com"]);
    expect(partial.join("")).not.toContain("\x1b]8;;");

    block.setText("[OpenAI](https://example.com)");
    const completed = block.render(80);

    expect(completed.map(stripAnsi)).toEqual(["OpenAI"]);
    expect(completed[0]).toContain("\x1b]8;;https://example.com/\x1b\\");
  });

  test("renders dollar and parenthesis inline math delimiters", () => {
    const rendered = new MarkdownBlock(
      String.raw`Map $\mathbb{C}^3 \to \mathbb{C}^3$ and \(x^2 + y_1\).`,
    )
      .render(80)
      .map(stripAnsi);

    expect(rendered).toEqual(["Map ℂ³ → ℂ³ and x² + y₁."]);
  });

  test("renders dollar and bracket display math delimiters", () => {
    const rendered = new MarkdownBlock(
      [
        "Before",
        "$$",
        String.raw`\frac{a+b}{c+d}`,
        "$$",
        String.raw`\[`,
        String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,
        String.raw`\]`,
        "After",
      ].join("\n"),
    )
      .render(80)
      .map(stripAnsi);

    expect(rendered).toEqual(["Before", "a+b", "───", "c+d", "⎛ 1 │ 2 ⎞", "⎝ 3 │ 4 ⎠", "After"]);
  });

  test("keeps streamed partial math literal until its delimiter closes", () => {
    const inline = new MarkdownBlock("Result $x^", {
      complete: false,
      trailingLineComplete: false,
    });
    expect(inline.render(80).map(stripAnsi)).toEqual(["Result $x^"]);

    inline.setText("Result $x^2$");
    expect(inline.render(80).map(stripAnsi)).toEqual(["Result x²"]);

    const display = new MarkdownBlock("$$\n\\frac{1}{", {
      complete: false,
      trailingLineComplete: false,
    });
    expect(display.render(80).map(stripAnsi)).toEqual(["$$", "\\frac{1}{"]);

    display.setText("$$\n\\frac{1}{2}\n$$");
    expect(display.render(80).map(stripAnsi)).toEqual(["1", "─", "2"]);
  });

  test("preserves unsupported math and math inside code", () => {
    const rendered = new MarkdownBlock(
      [
        String.raw`Value $x+\unknown{y}$ and \(\frac{1}{x\).`,
        "Use `$x^2$` literally.",
        "```latex",
        String.raw`$$\frac{1}{2}$$`,
        "```",
      ].join("\n"),
    )
      .render(100)
      .map(stripAnsi);

    expect(rendered).toEqual([
      String.raw`Value $x+\unknown{y}$ and \(\frac{1}{x\).`,
      "Use $x^2$ literally.",
      String.raw`    $$\frac{1}{2}$$`,
    ]);
  });

  test("keeps rendered display math when the terminal is narrow", () => {
    const rendered = new MarkdownBlock(
      String.raw`$$\begin{pmatrix}1234&5678\\90&12\end{pmatrix}$$`,
    ).render(10);
    const plain = rendered.map(stripAnsi);

    expect(plain.join("\n")).not.toContain(String.raw`\begin{pmatrix}`);
    expect(plain.join("\n")).toContain("⎛");
    expect(plain.join("\n")).toContain("⎠");
    expect(rendered.every((line) => visibleWidth(line) <= 10)).toBe(true);
  });

  test("preserves math source when LaTeX rendering is disabled", () => {
    const source = [
      "Inline $x^2$",
      "$$",
      String.raw`\frac{1}{2}`,
      "$$",
      "| Formula |",
      "| --- |",
      "| $y_1$ |",
    ].join("\n");
    const rendered = new MarkdownBlock(source, { renderLatex: false }).render(80).map(stripAnsi);

    expect(rendered.slice(0, 4)).toEqual(["Inline $x^2$", "$$", String.raw`\frac{1}{2}`, "$$"]);
    expect(rendered.join("\n")).toContain("$y_1$");
    expect(rendered.join("\n")).not.toContain("x²");
    expect(rendered.join("\n")).not.toContain("y₁");
  });

  test("aligns complete tables and supports rows without outer pipes", () => {
    const rendered = new MarkdownBlock(
      ["Name | Score | State", ":--- | ---: | :---:", "A | 7 | ok", "Long | 42 | done"].join("\n"),
    )
      .render(80)
      .map(stripAnsi);

    expect(rendered[1]).toContain("━");
    expect(rendered[3]).toContain("─");
    expect(rendered[0]?.indexOf("Name")).toBe(rendered[4]?.indexOf("Long"));
    expect((rendered[0]?.indexOf("Score") ?? 0) + "Score".length).toBe(
      (rendered[2]?.indexOf("7") ?? 0) + 1,
    );
    expect(rendered[2]?.indexOf("ok")).toBeGreaterThan(rendered[0]?.indexOf("State") ?? 0);
  });

  test("accepts compact delimiter cells with one or more hyphens", () => {
    const rendered = new MarkdownBlock(
      ["| Type | Count |", "| - | :--: |", "| DFS | 6 |", "| Tree | 7 |"].join("\n"),
    )
      .render(80)
      .map(stripAnsi);

    expect(rendered[1]).toContain("━");
    expect(rendered).not.toContain("| - | :--: |");
    expect(rendered.join("\n")).toContain("DFS");
    expect(rendered.join("\n")).toContain("Tree");
  });

  test("preserves empty cells and pipes inside escapes or inline code", () => {
    const raw = new MarkdownBlock(
      [
        "| Key | Value | Empty |",
        "| --- | --- | --- |",
        "| escaped | a\\|b | |",
        "| code | `x|y` | ok |",
      ].join("\n"),
    ).render(80);
    const rendered = raw.map(stripAnsi);

    expect(rendered).toContainEqual(expect.stringContaining("a|b"));
    expect(rendered).toContainEqual(expect.stringContaining("x|y"));
    expect(rendered).toContainEqual(expect.stringContaining("ok"));
    expect(raw).toContainEqual(expect.stringContaining(color("x|y", tuiTheme.markdownInlineCode)));
  });

  test("wraps wide table cells within the terminal width", () => {
    const rendered = new MarkdownBlock(
      [
        "| Name | Description |",
        "| --- | --- |",
        "| Kana | A long description that must wrap inside its column |",
      ].join("\n"),
    ).render(20);

    expect(rendered.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(rendered.map(stripAnsi).join("").replaceAll(/\s/g, "")).toContain(
      "Alongdescriptionthatmustwrapinsideitscolumn",
    );
  });

  test("falls back to key-value records when minimum columns do not fit", () => {
    const rendered = new MarkdownBlock(
      ["| Name | Status |", "| --- | --- |", "| Alice | Active |", "| Bob | Pending |"].join("\n"),
    )
      .render(10)
      .map(stripAnsi);

    expect(rendered).toEqual([
      " Name",
      "  Alice",
      " Status",
      "  Active",
      "──────────",
      " Name",
      "  Bob",
      " Status",
      "  Pending",
    ]);
  });

  test("keeps the streaming tail row visible without using it for column widths", () => {
    const text = [
      "| Key | Value |",
      "| --- | --- |",
      "| a | b |",
      "| growing-value | partial",
    ].join("\n");
    const streaming = new MarkdownBlock(text, {
      complete: false,
      trailingLineComplete: false,
    })
      .render(40)
      .map(stripAnsi);
    const complete = new MarkdownBlock(text).render(40).map(stripAnsi);

    expect(streaming).toContain("growing-value | partial");
    expect(visibleWidth(streaming[1] ?? "")).toBe(14);
    expect(visibleWidth(complete[1] ?? "")).toBeGreaterThan(14);
    expect(streaming.length).toBeLessThanOrEqual(complete.length);
  });

  test("keeps an incomplete table delimiter as plain text while streaming", () => {
    const rendered = new MarkdownBlock("| Name | Status |\n| --- |", {
      complete: false,
      trailingLineComplete: false,
    })
      .render(80)
      .map(stripAnsi);

    expect(rendered).toEqual(["| Name | Status |", "| --- |"]);
  });

  test("preserves angle-bracketed programming type syntax", () => {
    const rendered = new MarkdownBlock(
      "Use vector<int>, vector<unsigned int>, and map<string, vector<int>>.",
    ).render(120);

    expect(rendered.map(stripAnsi)).toEqual([
      "Use vector<int>, vector<unsigned int>, and map<string, vector<int>>.",
    ]);
  });

  test("wraps wide characters by visible terminal width", () => {
    const lines = new MarkdownBlock("- 你好世界", { color: "white" }).render(6);

    expect(lines.map(stripAnsi)).toEqual(["- 你好", "  世界"]);
    expect(lines.every((line) => visibleWidth(line) <= 6)).toBe(true);
  });
});

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}
