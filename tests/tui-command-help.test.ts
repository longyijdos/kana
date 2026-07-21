import { describe, expect, test } from "bun:test";
import {
  formatPromptCommandHelpLine,
  formatPromptCommandUsage,
  formatPromptShortcutHelpLine,
  PROMPT_COMMANDS,
  PROMPT_SHORTCUTS,
} from "../src/tui/components/editor/commands";

describe("prompt command help", () => {
  test("uses the same syntax for help lines and usage errors", () => {
    const fork = PROMPT_COMMANDS.find((command) => command.name === "fork");
    const memory = PROMPT_COMMANDS.find((command) => command.name === "memory");
    const mcp = PROMPT_COMMANDS.find((command) => command.name === "mcp");

    expect(fork).toBeDefined();
    expect(memory).toBeDefined();
    expect(mcp).toBeDefined();
    expect(formatPromptCommandHelpLine(fork!)).toContain("/fork <prompt>");
    expect(formatPromptCommandUsage("fork")).toBe("Usage: /fork <prompt>");
    expect(formatPromptCommandHelpLine(memory!)).toContain("/memory");
    expect(formatPromptCommandUsage("memory")).toBe("Usage: /memory");
    expect(formatPromptCommandHelpLine(mcp!)).toContain("/mcp");
    expect(formatPromptCommandUsage("mcp")).toBe("Usage: /mcp");
  });

  test("stores global shortcuts as structured help entries", () => {
    expect(PROMPT_SHORTCUTS).toContainEqual({
      input: "Ctrl+O",
      description: "Open the latest expandable tool output.",
    });
    expect(formatPromptShortcutHelpLine(PROMPT_SHORTCUTS[0])).toBe(
      "!<command> Run a local bash command.",
    );
  });
});
