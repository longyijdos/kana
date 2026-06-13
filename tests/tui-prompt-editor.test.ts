import { describe, expect, test } from "bun:test";
import {
  completeCommand,
  createCommandSubmit,
  getCommandState,
  PROMPT_COMMANDS,
} from "../src/tui/components/editor/commands";
import { Editor } from "../src/tui/components/editor";
import {
  createInputLayout,
  moveInputCursorVertically,
} from "../src/tui/components/editor/input-layout";
import { applyEditorAction } from "../src/tui/components/editor/state";
import { CURSOR_MARKER } from "../src/tui/runtime";
import { stripAnsi, visibleWidth } from "../src/tui/render";

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

    const cursorMarkers = editor
      .render(9)
      .join("")
      .split(CURSOR_MARKER).length - 1;

    expect(cursorMarkers).toBe(1);
  });

  test("highlights completed slash command token separately from arguments", () => {
    const editor = new Editor();

    editor.setText("/quit later");
    const rendered = editor.render(40).join("\n");

    expect(stripAnsi(rendered)).toContain("/quit later");
    expect(rendered).toContain("\x1b[35m/quit\x1b[0m later");
  });

  test("keeps multiline CJK editor rows inside the frame", () => {
    const editor = new Editor();

    editor.setText(
      [
        "3. | **write** — 创建新的文本文件。如果路径已存在则会失败，需要改用编辑工具。",
        "这些工具用于帮助你进行代码审查、文件操作和项目",
      ].join("\n"),
    );
    editor.handleInput("\x1b[D");

    for (const line of editor.render(40)) {
      const plain = stripAnsi(line);

      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
      expect(plain.startsWith("+") || plain.startsWith("|")).toBe(true);
      expect(plain.endsWith("+") || plain.endsWith("|")).toBe(true);
    }
  });

  test("normalizes pasted CRLF line endings before rendering", () => {
    const editor = new Editor();

    editor.handleInput("\x1b[200~a\r\nb\rc\x1b[201~");

    expect(editor.getText()).toBe("a\nb\nc");

    for (const line of editor.render(20)) {
      const plain = stripAnsi(line);

      expect(plain).not.toContain("\r");
      expect(plain).not.toContain("\n");
      expect(visibleWidth(line)).toBe(20);
      expect(plain.startsWith("+") || plain.startsWith("|")).toBe(true);
      expect(plain.endsWith("+") || plain.endsWith("|")).toBe(true);
    }
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

  test("hides the palette after command token whitespace", () => {
    expect(getCommandState("/quit ")).toMatchObject({
      isCommandMode: true,
      showPalette: false,
      query: "quit",
    });
  });
});
