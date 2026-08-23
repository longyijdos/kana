import { describe, expect, test } from "bun:test";
import {
  formatPromptCommandHelpLine,
  formatPromptCommandUsage,
  PROMPT_COMMANDS,
} from "../../src/tui/components/editor/commands";

describe("prompt command help", () => {
  test("uses the same syntax for help lines and usage errors", () => {
    const fork = PROMPT_COMMANDS.find((command) => command.name === "fork");
    const memory = PROMPT_COMMANDS.find((command) => command.name === "memory");
    const mcp = PROMPT_COMMANDS.find((command) => command.name === "mcp");
    const schedule = PROMPT_COMMANDS.find((command) => command.name === "schedule");
    const approval = PROMPT_COMMANDS.find((command) => command.name === "approval");
    const compact = PROMPT_COMMANDS.find((command) => command.name === "compact");
    const tools = PROMPT_COMMANDS.find((command) => command.name === "tools");

    expect(fork).toBeDefined();
    expect(memory).toBeDefined();
    expect(mcp).toBeDefined();
    expect(schedule).toBeDefined();
    expect(approval).toBeDefined();
    expect(compact).toBeDefined();
    expect(formatPromptCommandHelpLine(fork!)).toContain("/fork <prompt>");
    expect(formatPromptCommandUsage("fork")).toBe("Usage: /fork <prompt>");
    expect(formatPromptCommandHelpLine(memory!)).toContain("/memory");
    expect(formatPromptCommandUsage("memory")).toBe("Usage: /memory");
    expect(formatPromptCommandHelpLine(mcp!)).toContain("/mcp");
    expect(formatPromptCommandUsage("mcp")).toBe("Usage: /mcp");
    expect(formatPromptCommandHelpLine(schedule!)).toContain("/schedule");
    expect(formatPromptCommandUsage("schedule")).toBe("Usage: /schedule");
    expect(formatPromptCommandHelpLine(approval!)).toContain("/approval");
    expect(formatPromptCommandUsage("approval")).toBe("Usage: /approval");
    expect(formatPromptCommandHelpLine(compact!)).toContain("/compact");
    expect(formatPromptCommandUsage("compact")).toBe("Usage: /compact");
    expect(tools).toBeDefined();
    expect(tools!.description).toBe("Browse tool calls in this session.");
    expect(formatPromptCommandHelpLine(tools!)).toContain("/tools");
    expect(formatPromptCommandHelpLine(tools!)).toContain("Browse tool calls");
    expect(formatPromptCommandUsage("tools")).toBe("Usage: /tools");
    expect(tools!.argumentSyntax).toBeUndefined();
  });
});
