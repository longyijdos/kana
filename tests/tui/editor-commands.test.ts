import { describe, expect, test } from "bun:test";
import {
  completeCommand,
  createCommandSubmit,
  createRandomPromptPlaceholder,
  getCommandState,
  PROMPT_COMMANDS,
  PROMPT_SHORTCUTS,
} from "../../src/tui/components/editor/commands";

describe("prompt commands", () => {
  test("creates prompt placeholders from help command entries", () => {
    const helpEntryCount = PROMPT_COMMANDS.length + PROMPT_SHORTCUTS.length;

    expect(createRandomPromptPlaceholder(() => 0)).toBe("Try /quit — Exit Kana.");
    expect(
      createRandomPromptPlaceholder(
        () => PROMPT_COMMANDS.findIndex((command) => command.name === "usage") / helpEntryCount,
      ),
    ).toBe("Try /usage — Show session, project, or global API usage.");
    expect(createRandomPromptPlaceholder(() => 0.999)).toBe(
      "Try !<command> — Run a local bash command.",
    );
    expect(createRandomPromptPlaceholder(() => 0, "Try /quit — Exit Kana.")).toBe(
      "Try /help — Show commands and shortcuts.",
    );
    expect(createRandomPromptPlaceholder(() => 6 / helpEntryCount)).toBe(
      "Try /delete — Delete a saved session.",
    );
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
          name: "jobs",
        },
        {
          name: "goal",
        },
        {
          name: "todo",
        },
        {
          name: "tools",
        },
        {
          name: "image",
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
