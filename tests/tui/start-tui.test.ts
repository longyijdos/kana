import { describe, expect, test } from "bun:test";
import { startTui } from "../../src/tui";

describe("TUI startup", () => {
  test("rejects saved-session entry points in clean mode", async () => {
    await expect(
      startTui({ launchMode: "clean", resumeSessionId: "saved-session" }),
    ).rejects.toThrow("Clean mode cannot resume saved sessions because its session is temporary.");
    await expect(startTui({ launchMode: "clean", showResumePicker: true })).rejects.toThrow(
      "Clean mode cannot resume saved sessions because its session is temporary.",
    );
  });
});
