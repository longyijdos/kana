import { describe, expect, test } from "bun:test";
import {
  completeCommand,
  createCommandSubmit,
  getCommandState,
  PROMPT_COMMANDS,
} from "../src/tui/editor/commands";
import { Editor } from "../src/tui/editor/editor";
import { createInputLayout } from "../src/tui/editor/input-layout";
import { applyEditorAction } from "../src/tui/editor/state";
import { CURSOR_MARKER } from "../src/tui/runtime/cursor";
import { stripAnsi, visibleWidth } from "../src/tui/render/width";

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
          name: "clear",
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
