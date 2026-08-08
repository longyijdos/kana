import { describe, expect, test } from "bun:test";
import { Editor } from "../../src/tui/components/editor";
import {
  completeCommand,
  createCommandSubmit,
  createRandomPromptPlaceholder,
  formatPromptCommandHelpLine,
  getCommandState,
  PROMPT_COMMANDS,
} from "../../src/tui/components/editor/commands";
import {
  createInputLayout,
  moveInputCursorVertically,
} from "../../src/tui/components/editor/input-layout";
import { applyEditorAction } from "../../src/tui/components/editor/state";
import { stripAnsi, visibleWidth } from "../../src/tui/render";
import { CURSOR_MARKER } from "../../src/tui/runtime";
import { tuiTheme } from "../../src/tui/theme";

function cursorLine(lines: string[]): number {
  return lines.findIndex((line) => line.includes(CURSOR_MARKER));
}

describe("prompt editor", () => {
  test("inserts text at the cursor", () => {
    const moved = applyEditorAction(
      {
        value: "helo",
        cursorOffset: 4,
      },
      {
        type: "moveLeft",
      },
    );

    expect(
      applyEditorAction(moved, {
        type: "insert",
        text: "l",
      }),
    ).toEqual({
      value: "hello",
      cursorOffset: 4,
    });
  });

  test("moves over grapheme clusters", () => {
    const value = "a👨‍👩‍👧‍👦b";
    const moved = applyEditorAction(
      {
        value,
        cursorOffset: value.length,
      },
      {
        type: "moveLeft",
      },
    );

    expect(moved.cursorOffset).toBe(value.length - 1);

    expect(
      applyEditorAction(moved, {
        type: "moveLeft",
      }).cursorOffset,
    ).toBe(1);
  });

  test("deletes complete grapheme clusters", () => {
    const value = "a👨‍👩‍👧‍👦b";

    expect(
      applyEditorAction(
        {
          value,
          cursorOffset: value.length - 1,
        },
        {
          type: "deleteBefore",
        },
      ),
    ).toEqual({
      value: "ab",
      cursorOffset: 1,
    });
  });

  test("renders only one cursor at a wrapped line boundary", () => {
    const editor = new Editor();

    editor.setText("abcd");
    editor.handleInput("\x1b[D");

    const cursorMarkers = editor.render(9).join("").split(CURSOR_MARKER).length - 1;

    expect(cursorMarkers).toBe(1);
  });

  test("shows a stable help entry placeholder while empty and changes it after Enter", () => {
    const editor = new Editor();
    const firstRender = editor.render(80);
    const inputLine = firstRender.find((line) => line.includes(CURSOR_MARKER));

    expect(inputLine).toBeDefined();
    expect(stripAnsi(inputLine ?? "")).toMatch(/^\| > Try .+ — .+\s+\|$/);
    expect(editor.render(80)).toEqual(firstRender);

    editor.handleInput("\r");

    expect(editor.render(80)).not.toEqual(firstRender);

    editor.setText("hello");

    expect(stripAnsi(editor.render(80).join("\n"))).not.toContain("Try ");
  });

  test("highlights completed slash command token separately from arguments", () => {
    const editor = new Editor();

    editor.setText("/quit later");
    const rendered = editor.render(40).join("\n");
    const command = `\x1b[38;2;${tuiTheme.command.join(";")}m`;
    const text = `\x1b[38;2;${tuiTheme.userMessageText.join(";")}m`;

    expect(stripAnsi(rendered)).toContain("/quit later");
    expect(rendered).toContain(`${command}/quit${text} later`);
  });

  test("paginates slash commands and stops selection at the list boundaries", () => {
    const editor = new Editor({ commandPaletteVisibleLimit: 3 });
    const submissions: unknown[] = [];
    editor.onSubmit = (submit) => {
      submissions.push(submit);
    };

    editor.setText("/");

    expect(editor.render(80).map(stripAnsi)).toEqual(
      expect.arrayContaining([
        `> ${formatPromptCommandHelpLine(PROMPT_COMMANDS[0])}`,
        `  ${formatPromptCommandHelpLine(PROMPT_COMMANDS[1])}`,
        `  ${formatPromptCommandHelpLine(PROMPT_COMMANDS[2])}`,
        `... ${PROMPT_COMMANDS.length - 3} more commands`,
      ]),
    );

    const lastIndex = PROMPT_COMMANDS.length - 1;
    for (let index = 0; index < lastIndex; index += 1) {
      editor.handleInput("\x1b[B");
    }

    expect(editor.render(80).map(stripAnsi)).toEqual(
      expect.arrayContaining([
        `... ${PROMPT_COMMANDS.length - 3} earlier commands`,
        `  ${formatPromptCommandHelpLine(PROMPT_COMMANDS[lastIndex - 2])}`,
        `  ${formatPromptCommandHelpLine(PROMPT_COMMANDS[lastIndex - 1])}`,
        `> ${formatPromptCommandHelpLine(PROMPT_COMMANDS[lastIndex])}`,
      ]),
    );

    editor.handleInput("\x1b[B");
    editor.handleInput("\r");

    expect(submissions).toEqual([
      {
        type: "command",
        name: "usage",
        arguments: "",
        raw: "/",
      },
    ]);

    for (let index = 0; index < PROMPT_COMMANDS.length; index += 1) {
      editor.handleInput("\x1b[A");
    }
    editor.handleInput("\r");

    expect(submissions.at(-1)).toEqual({
      type: "command",
      name: "quit",
      arguments: "",
      raw: "/",
    });
  });

  test("fits input and slash command rendering within the available height", () => {
    const editor = new Editor({
      model: "deepseek/deepseek-chat",
    });

    editor.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
    expect(editor.render(40, 15).length).toBeLessThanOrEqual(15);

    editor.setText("/");
    const palette = editor.render(40, 15).map(stripAnsi);

    expect(palette.length).toBeLessThanOrEqual(15);
    expect(palette.some((line) => line.includes("/help"))).toBe(true);
    expect(palette.some((line) => line.includes("deepseek/deepseek-chat"))).toBe(false);
  });

  test("renders input inside an ASCII frame without background color", () => {
    const editor = new Editor();

    editor.setText("hello");
    const rendered = editor.render(20);
    const accent = `\x1b[38;2;${tuiTheme.user.join(";")}m`;
    const text = `\x1b[38;2;${tuiTheme.userMessageText.join(";")}m`;

    expect(rendered.slice(0, -1).map(stripAnsi)).toEqual([
      "+------------------+",
      "| > hello          |",
      "+------------------+",
    ]);
    expect(rendered.join("\n")).not.toContain("\x1b[48;");
    expect(rendered.join("\n")).not.toContain("\x1b[K");
    expect(rendered[1]).toContain(`${accent}> ${text}hello`);
  });

  test("keeps multiline CJK editor rows inside the ASCII frame", () => {
    const editor = new Editor();

    editor.setText(
      [
        "3. | **write** — 写入完整文本文件。覆盖既有文件时需要显式传入 overwrite。",
        "这些工具用于帮助你进行代码审查、文件操作和项目",
      ].join("\n"),
    );
    editor.handleInput("\x1b[D");

    const rendered = editor.render(40);

    for (const line of rendered) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(rendered.map(stripAnsi).at(0)).toBe(`+${"-".repeat(38)}+`);
    expect(rendered.map(stripAnsi).at(-2)).toBe(`+${"-".repeat(38)}+`);
    expect(rendered.join("\n")).not.toContain("\x1b[48;");
    expect(rendered.join("\n")).not.toContain("\x1b[K");
  });

  test("normalizes pasted CRLF line endings before rendering", () => {
    const editor = new Editor();

    editor.handleInput("\x1b[200~a\r\nb\rc\x1b[201~");

    expect(editor.getText()).toBe("a\nb\nc");

    const rendered = editor.render(20);

    for (const line of rendered) {
      const plain = stripAnsi(line);

      expect(plain).not.toContain("\r");
      expect(plain).not.toContain("\n");
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }

    expect(rendered.join("\n")).not.toContain("\x1b[48;");
    expect(rendered.slice(0, -1).map(stripAnsi)).toEqual([
      "+------------------+",
      "| > a              |",
      "|   b              |",
      "|   c              |",
      "+------------------+",
    ]);
  });

  test("inserts newline with Shift+Enter before submitting with Enter", () => {
    const editor = new Editor();
    const submissions: unknown[] = [];
    editor.onSubmit = (submit) => {
      submissions.push(submit);
    };

    editor.handleInput("hello");
    editor.handleInput("\x1b[13;2u");
    editor.handleInput("world");

    expect(editor.getText()).toBe("hello\nworld");
    expect(submissions).toEqual([]);

    editor.handleInput("\r");

    expect(submissions).toEqual([
      {
        type: "message",
        content: "hello\nworld",
      },
    ]);
  });

  test("queues ordinary input with Tab while preserving slash completion", () => {
    const editor = new Editor();
    const queued: unknown[] = [];
    editor.onQueue = (submit) => {
      queued.push(submit);
    };

    editor.setText("Queue this message.");
    editor.handleInput("\t");

    expect(queued).toEqual([
      {
        type: "message",
        content: "Queue this message.",
      },
    ]);

    editor.setText("/he");
    editor.handleInput("\t");

    expect(editor.getText()).toBe("/help ");
    expect(queued).toHaveLength(1);
  });

  test("renders queued and scheduled previews below status and hides them for slash commands", () => {
    const editor = new Editor({ model: "test-model" });
    editor.updateStatus({ phase: "responding", running: true });
    editor.setQueuedInputs([
      { delivery: "turn", content: "Use the new direction." },
      { delivery: "run", content: "Check types after this run." },
      { delivery: "scheduled", content: "Check task progress." },
      { delivery: "run", content: "First line\nSecond line" },
      { delivery: "run", content: "Fourth input" },
      { delivery: "run", content: "Fifth input" },
    ]);
    editor.setScheduledInputSummary({
      count: 3,
      nextAt: new Date(2026, 7, 8, 14, 30),
    });

    const rendered = editor.render(48, 14).map(stripAnsi);

    expect(rendered).toContain("Queued inputs · 6");
    expect(rendered).toContain("  next turn · Use the new direction.");
    expect(rendered).toContain("  scheduled · Check task progress.");
    expect(rendered.at(-2)).toMatch(/… \d+ more/);
    expect(rendered.at(-1)).toBe("Scheduled · 3 · next 14:30");
    expect(rendered.length).toBeLessThanOrEqual(14);

    editor.setText("/");
    const slashRendered = stripAnsi(editor.render(48, 14).join("\n"));
    expect(slashRendered).not.toContain("Queued inputs");
    expect(slashRendered).not.toContain("Scheduled · 3");
  });

  test("strips terminal control sequences from queued previews", () => {
    const editor = new Editor();
    editor.setQueuedInputs([
      {
        delivery: "scheduled",
        content: "CSI\x1b[2J OSC\x1b]0;owned\x07 C0\x00\x08",
      },
    ]);

    const rendered = editor.render(48).join("\n");

    expect(stripAnsi(rendered)).toContain("scheduled · CSI OSC C0");
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered).not.toContain("\x1b]0;owned\x07");
    expect(rendered).not.toContain("\x00");
    expect(rendered).not.toContain("\x08");
  });

  test("moves up within multiline input before switching history", () => {
    const editor = new Editor();

    editor.addToHistory("previous");
    editor.setText("abc\ndef");
    editor.render(20);
    editor.handleInput("\x1b[A");
    editor.handleInput("X");

    expect(editor.getText()).toBe("abcX\ndef");
  });

  test("moves up through three visible lines before the input boundary", () => {
    const editor = new Editor();

    editor.setText("one\ntwo\nthree");
    editor.render(20);

    editor.handleInput("\x1b[A");
    expect(cursorLine(editor.render(20))).toBe(2);

    editor.handleInput("\x1b[A");
    expect(cursorLine(editor.render(20))).toBe(1);

    editor.handleInput("\x1b[A");
    expect(cursorLine(editor.render(20))).toBe(1);
  });

  test("moves up within the visible input window before scrolling it", () => {
    const editor = new Editor();

    editor.setText("one\ntwo\nthree\nfour\nfive\nsix");
    const initial = editor.render(20).map(stripAnsi);

    expect(initial.some((line) => line.includes("one"))).toBe(false);
    expect(initial.some((line) => line.includes("six"))).toBe(true);
    expect(cursorLine(editor.render(20))).toBe(5);

    editor.handleInput("\x1b[A");

    const afterFirstUp = editor.render(20).map(stripAnsi);

    expect(cursorLine(editor.render(20))).toBe(4);
    expect(afterFirstUp.some((line) => line.includes("one"))).toBe(false);
    expect(afterFirstUp.some((line) => line.includes("six"))).toBe(true);

    editor.handleInput("\x1b[A");
    editor.handleInput("\x1b[A");
    editor.handleInput("\x1b[A");
    editor.handleInput("\x1b[A");

    const afterScroll = editor.render(20).map(stripAnsi);

    expect(cursorLine(editor.render(20))).toBe(1);
    expect(afterScroll.some((line) => line.includes("one"))).toBe(true);
    expect(afterScroll.some((line) => line.includes("six"))).toBe(false);
  });

  test("moves down within multiline input before switching history", () => {
    const editor = new Editor();

    editor.addToHistory("previous");
    editor.setText("abc\ndef");
    editor.render(20);
    editor.handleInput("\x1b[H");
    editor.handleInput("\x1b[B");
    editor.handleInput("X");

    expect(editor.getText()).toBe("abc\nXdef");
  });

  test("moves down through three visible lines before the input boundary", () => {
    const editor = new Editor();

    editor.setText("one\ntwo\nthree");
    editor.render(20);
    editor.handleInput("\x1b[H");

    editor.handleInput("\x1b[B");
    expect(cursorLine(editor.render(20))).toBe(2);

    editor.handleInput("\x1b[B");
    expect(cursorLine(editor.render(20))).toBe(3);

    editor.handleInput("\x1b[B");
    expect(cursorLine(editor.render(20))).toBe(3);
  });

  test("moves down within the visible input window before scrolling it", () => {
    const editor = new Editor();

    editor.setText("one\ntwo\nthree\nfour\nfive\nsix");
    editor.render(20);
    editor.handleInput("\x1b[H");

    const initial = editor.render(20).map(stripAnsi);

    expect(initial.some((line) => line.includes("one"))).toBe(true);
    expect(initial.some((line) => line.includes("six"))).toBe(false);
    expect(cursorLine(editor.render(20))).toBe(1);

    editor.handleInput("\x1b[B");

    const afterFirstDown = editor.render(20).map(stripAnsi);

    expect(cursorLine(editor.render(20))).toBe(2);
    expect(afterFirstDown.some((line) => line.includes("one"))).toBe(true);
    expect(afterFirstDown.some((line) => line.includes("six"))).toBe(false);

    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");

    const afterScroll = editor.render(20).map(stripAnsi);

    expect(cursorLine(editor.render(20))).toBe(5);
    expect(afterScroll.some((line) => line.includes("one"))).toBe(false);
    expect(afterScroll.some((line) => line.includes("six"))).toBe(true);
  });

  test("moves to the input start before switching history upward", () => {
    const editor = new Editor();

    editor.addToHistory("previous");
    editor.setText("abc\ndef");
    editor.render(20);
    editor.handleInput("\x1b[A");

    expect(editor.getText()).toBe("abc\ndef");

    editor.handleInput("\x1b[A");

    expect(editor.getText()).toBe("abc\ndef");

    editor.handleInput("X");

    expect(editor.getText()).toBe("Xabc\ndef");
  });

  test("switches history only beyond the input start", () => {
    const editor = new Editor();

    editor.addToHistory("previous");
    editor.setText("abc\ndef");
    editor.render(20);
    editor.handleInput("\x1b[A");
    editor.handleInput("\x1b[A");
    editor.handleInput("\x1b[A");

    expect(editor.getText()).toBe("previous");

    editor.handleInput("\x1b[B");

    expect(editor.getText()).toBe("");
  });

  test("moves to the input end before switching history downward", () => {
    const editor = new Editor();

    editor.addToHistory("previous");
    editor.setText("abc\ndef");
    editor.render(20);
    editor.handleInput("\x1b[H");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    editor.handleInput("X");

    expect(editor.getText()).toBe("abc\ndefX");
  });

  test("switches history only beyond the input end", () => {
    const editor = new Editor();

    editor.addToHistory("previous");
    editor.setText("current");
    editor.render(20);
    editor.handleInput("\x1b[A");
    editor.handleInput("\x1b[A");

    expect(editor.getText()).toBe("previous");

    editor.handleInput("\x1b[H");
    editor.handleInput("\x1b[B");

    expect(editor.getText()).toBe("previous");

    editor.handleInput("\x1b[B");

    expect(editor.getText()).toBe("");
  });

  test("moves vertically through soft-wrapped input", () => {
    const editor = new Editor();

    editor.setText("abcdef");
    editor.render(9);
    editor.handleInput("\x1b[H");
    editor.handleInput("\x1b[B");
    editor.handleInput("X");

    expect(editor.getText()).toBe("abcXdef");
  });

  test("keeps a soft-wrap boundary cursor on the next line", () => {
    const editor = new Editor();

    editor.setText("abcdef");
    editor.render(9);
    editor.handleInput("\x1b[A");

    const cursorLine = editor.render(9).findIndex((line) => line.includes(CURSOR_MARKER));

    expect(cursorLine).toBe(2);
  });

  test("moves left from a soft-wrap line start before the previous character", () => {
    const editor = new Editor();

    editor.setText("abcdef");
    editor.render(9);
    editor.handleInput("\x1b[H");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[D");
    editor.handleInput("X");

    expect(editor.getText()).toBe("abXcdef");
  });
});

describe("prompt input layout", () => {
  test("uses one line by default", () => {
    expect(
      createInputLayout({
        value: "hello",
        cursorOffset: 5,
        columns: 10,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "hello",
        },
      ],
      cursor: {
        line: 0,
        column: 5,
      },
      isTruncatedStart: false,
    });
  });

  test("wraps up to the maximum and truncates earlier lines", () => {
    expect(
      createInputLayout({
        value: "abcdefghijkl",
        cursorOffset: 12,
        columns: 3,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "def",
        },
        {
          text: "ghi",
        },
        {
          text: "jkl",
        },
      ],
      cursor: {
        line: 2,
        column: 3,
      },
      isTruncatedStart: true,
    });
  });

  test("keeps the cursor visible when it moves inside wrapped text", () => {
    expect(
      createInputLayout({
        value: "abcdefghijkl",
        cursorOffset: 4,
        columns: 3,
        maxLines: 2,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "abc",
        },
        {
          text: "def",
        },
      ],
      cursor: {
        line: 1,
        column: 1,
      },
      isTruncatedStart: false,
    });
  });

  test("places the cursor on the next line at a wrapped boundary", () => {
    expect(
      createInputLayout({
        value: "abcdef",
        cursorOffset: 3,
        columns: 3,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "abc",
        },
        {
          text: "def",
        },
      ],
      cursor: {
        line: 1,
        column: 0,
      },
    });
  });

  test("keeps the cursor on the only line when text exactly fills it", () => {
    expect(
      createInputLayout({
        value: "abc",
        cursorOffset: 3,
        columns: 3,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "abc",
        },
      ],
      cursor: {
        line: 0,
        column: 3,
      },
    });
  });

  test("treats CRLF and CR as line breaks", () => {
    expect(
      createInputLayout({
        value: "a\r\nb\rc",
        cursorOffset: 5,
        columns: 10,
        maxLines: 5,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "a",
        },
        {
          text: "b",
        },
        {
          text: "c",
        },
      ],
      cursor: {
        line: 2,
        column: 0,
      },
    });
  });

  test("moves the cursor vertically between wrapped input lines", () => {
    expect(
      moveInputCursorVertically({
        value: "abc\ndef",
        cursorOffset: 7,
        columns: 10,
        direction: -1,
      }),
    ).toBe(3);

    expect(
      moveInputCursorVertically({
        value: "abcdef",
        cursorOffset: 0,
        columns: 3,
        direction: 1,
      }),
    ).toBe(3);
  });

  test("does not move vertically beyond input boundaries", () => {
    expect(
      moveInputCursorVertically({
        value: "abc",
        cursorOffset: 0,
        columns: 10,
        direction: -1,
      }),
    ).toBeUndefined();

    expect(
      moveInputCursorVertically({
        value: "abc",
        cursorOffset: 3,
        columns: 10,
        direction: 1,
      }),
    ).toBeUndefined();
  });

  test("accounts for wide characters", () => {
    expect(
      createInputLayout({
        value: "你好a",
        cursorOffset: 3,
        columns: 4,
        maxLines: 3,
      }),
    ).toMatchObject({
      lines: [
        {
          text: "你好",
        },
        {
          text: "a",
        },
      ],
      cursor: {
        line: 1,
        column: 1,
      },
    });
  });
});

describe("prompt commands", () => {
  test("creates prompt placeholders from help command entries", () => {
    expect(createRandomPromptPlaceholder(() => 0)).toBe("Try /quit — Exit Kana.");
    expect(createRandomPromptPlaceholder(() => 0.85)).toBe(
      "Try /usage — Show session, project, or global API usage.",
    );
    expect(createRandomPromptPlaceholder(() => 0.999)).toBe(
      "Try Ctrl+O — Open the latest expandable tool output.",
    );
    expect(createRandomPromptPlaceholder(() => 0, "Try /quit — Exit Kana.")).toBe(
      "Try /help — Show slash commands.",
    );
    expect(createRandomPromptPlaceholder(() => 0.4)).toBe("Try /delete — Delete a saved session.");
  });

  test("lists commands after slash", () => {
    expect(getCommandState("/")).toMatchObject({
      isCommandMode: true,
      showPalette: true,
      query: "",
      suggestions: [
        {
          name: "quit",
        },
        {
          name: "help",
        },
        {
          name: "clear",
        },
        {
          name: "new",
        },
        {
          name: "fork",
        },
        {
          name: "resume",
        },
        {
          name: "delete",
        },
        {
          name: "skills",
        },
        {
          name: "mcp",
        },
        {
          name: "schedule",
        },
        {
          name: "approval",
        },
        {
          name: "model",
        },
        {
          name: "memory",
        },
        {
          name: "compact",
        },
        {
          name: "usage",
        },
      ],
    });
  });

  test("filters and completes commands", () => {
    const command = getCommandState("/qu").suggestions[0];

    expect(command).toMatchObject({
      name: "quit",
    });
    expect(command).toBeDefined();
    if (!command) {
      throw new Error("Expected command suggestion.");
    }
    expect(completeCommand(command)).toBe("/quit ");
  });

  test("creates command submissions from partial input and selection", () => {
    expect(createCommandSubmit("/", PROMPT_COMMANDS[0])).toEqual({
      type: "command",
      name: "quit",
      arguments: "",
      raw: "/",
    });
    expect(createCommandSubmit("/quit", undefined)).toEqual({
      type: "command",
      name: "quit",
      arguments: "",
      raw: "/quit",
    });
    expect(createCommandSubmit("/help", undefined)).toEqual({
      type: "command",
      name: "help",
      arguments: "",
      raw: "/help",
    });
    expect(createCommandSubmit("/new", undefined)).toEqual({
      type: "command",
      name: "new",
      arguments: "",
      raw: "/new",
    });
    expect(createCommandSubmit("/fork", undefined)).toEqual({
      type: "command",
      name: "fork",
      arguments: "",
      raw: "/fork",
    });
    expect(createCommandSubmit("/resume", undefined)).toEqual({
      type: "command",
      name: "resume",
      arguments: "",
      raw: "/resume",
    });
    expect(createCommandSubmit("/delete", undefined)).toEqual({
      type: "command",
      name: "delete",
      arguments: "",
      raw: "/delete",
    });
  });

  test("submits command input with arguments", () => {
    expect(createCommandSubmit("/quit later", undefined)).toEqual({
      type: "command",
      name: "quit",
      arguments: "later",
      raw: "/quit later",
    });
    expect(createCommandSubmit("/quit ", undefined)).toEqual({
      type: "command",
      name: "quit",
      arguments: "",
      raw: "/quit ",
    });
  });

  test("submits unmatched slash-prefixed input as a message", () => {
    expect(createCommandSubmit("/tmp 会在什么时候自动删除呢", undefined)).toEqual({
      type: "message",
      content: "/tmp 会在什么时候自动删除呢",
    });
    expect(createCommandSubmit("/tmp", PROMPT_COMMANDS[0])).toEqual({
      type: "message",
      content: "/tmp",
    });
  });

  test("creates shell submissions from bang-prefixed input", () => {
    expect(createCommandSubmit("!", undefined)).toEqual({
      type: "message",
      content: "!",
    });
    expect(createCommandSubmit("!   ", undefined)).toEqual({
      type: "message",
      content: "!   ",
    });
    expect(createCommandSubmit("!pwd", undefined)).toEqual({
      type: "shell",
      command: "pwd",
      raw: "!pwd",
    });
    expect(createCommandSubmit("!  git status  ", undefined)).toEqual({
      type: "shell",
      command: "git status",
      raw: "!  git status  ",
    });
  });

  test("hides the palette after command token whitespace", () => {
    expect(getCommandState("/quit ")).toMatchObject({
      isCommandMode: true,
      showPalette: false,
      query: "quit",
    });
  });
});
