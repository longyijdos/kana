import { describe, expect, test } from "bun:test";
import {
  completeCommand,
  createCommandSubmit,
  createRandomPromptPlaceholder,
  getCommandState,
  PROMPT_COMMANDS,
  PROMPT_SHORTCUTS,
  PROMPT_SKILL_SHORTCUT,
  PROMPT_TEMPLATE_SHORTCUT,
} from "../../src/tui/components/editor/commands";

describe("prompt commands", () => {
  test("creates prompt placeholders from help command entries", () => {
    const helpEntryCount = PROMPT_COMMANDS.length + PROMPT_SHORTCUTS.length + 2;

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
    expect(createRandomPromptPlaceholder(() => PROMPT_COMMANDS.length / helpEntryCount)).toBe(
      `Try ${PROMPT_SKILL_SHORTCUT.input} — ${PROMPT_SKILL_SHORTCUT.description}`,
    );
    expect(createRandomPromptPlaceholder(() => (PROMPT_COMMANDS.length + 1) / helpEntryCount)).toBe(
      `Try ${PROMPT_TEMPLATE_SHORTCUT.input} — ${PROMPT_TEMPLATE_SHORTCUT.description}`,
    );
    expect(
      createRandomPromptPlaceholder(
        () => PROMPT_COMMANDS.findIndex((command) => command.name === "resume") / helpEntryCount,
      ),
    ).toBe("Try /resume [id] — Resume or delete a saved session.");
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
          name: "btw",
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
          name: "agents",
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
    expect(createCommandSubmit("/btw", undefined)).toEqual({
      type: "command",
      name: "btw",
      arguments: "",
      raw: "/btw",
    });
    expect(createCommandSubmit("/btw Why this approach?", undefined)).toEqual({
      type: "command",
      name: "btw",
      arguments: "Why this approach?",
      raw: "/btw Why this approach?",
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
  });

  test("treats the removed delete command as a normal message", () => {
    expect(PROMPT_COMMANDS.map((command) => command.name as string)).not.toContain("delete");
    expect(getCommandState("/delete").suggestions).toEqual([]);
    expect(createCommandSubmit("/delete", undefined)).toEqual({
      type: "message",
      content: "/delete",
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
