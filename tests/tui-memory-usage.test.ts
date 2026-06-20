import { describe, expect, test } from "bun:test";
import { COMMAND_MESSAGES } from "../src/tui/app/command-messages";

describe("memory command usage", () => {
  test("documents commands, targets, and defaults", () => {
    expect(COMMAND_MESSAGES.memoryUsage).toContain("/memory show [user|workspace]");
    expect(COMMAND_MESSAGES.memoryUsage).toContain("/memory compact [user|workspace] [request]");
    expect(COMMAND_MESSAGES.memoryUsage).toContain("Omit the target to show both.");
    expect(COMMAND_MESSAGES.memoryUsage).toContain("Omit the target to compact both.");
    expect(COMMAND_MESSAGES.memoryUsage).not.toContain("Examples:");
  });
});
