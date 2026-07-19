import { describe, expect, test } from "bun:test";
import { COMMAND_MESSAGES } from "../src/tui/app/command-messages";

describe("memory command usage", () => {
  test("requires options to be selected outside the editor", () => {
    expect(COMMAND_MESSAGES.memoryUsage).toBe("Usage: /memory");
    expect(COMMAND_MESSAGES.usageUsage).toBe("Usage: /usage");
  });
});
