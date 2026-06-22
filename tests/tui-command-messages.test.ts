import { expect, test } from "bun:test";
import { COMMAND_MESSAGES } from "../src/tui/app/command-messages";

test("documents the expandable tool output shortcut", () => {
  expect(COMMAND_MESSAGES.toolShortcut).toBe("Ctrl+O Open the latest expandable tool output.");
});
