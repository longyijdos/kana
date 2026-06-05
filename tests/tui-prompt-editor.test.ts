import { describe, expect, test } from "bun:test";
import {
  completeCommand,
  createCommandSubmit,
  getCommandState,
  PROMPT_COMMANDS,
} from "../src/tui/prompt/commands";
import { applyPromptEditorAction } from "../src/tui/prompt/use-prompt-editor";

describe("prompt editor", () => {
  test("inserts text at the cursor", () => {
    const moved = applyPromptEditorAction(
      {
        value: "helo",
        cursorOffset: 4,
      },
      {
        type: "moveLeft",
      },
    );

    expect(
      applyPromptEditorAction(moved, {
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
    const moved = applyPromptEditorAction(
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
      applyPromptEditorAction(moved, {
        type: "moveLeft",
      }).cursorOffset,
    ).toBe(1);
  });

  test("deletes complete grapheme clusters", () => {
    const value = "a👨‍👩‍👧‍👦b";

    expect(
      applyPromptEditorAction(
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
      raw: "/",
    });
    expect(createCommandSubmit("/quit", undefined)).toEqual({
      type: "command",
      name: "quit",
      raw: "/quit",
    });
  });

  test("submits command input with trailing text as a message", () => {
    expect(createCommandSubmit("/quit later", undefined)).toEqual({
      type: "message",
      content: "/quit later",
    });
    expect(createCommandSubmit("/quit ", undefined)).toEqual({
      type: "command",
      name: "quit",
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
