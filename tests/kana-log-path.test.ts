import { describe, expect, test } from "bun:test";
import { getKanaSessionLogPath } from "@/kana";

describe("Kana log paths", () => {
  test("uses the same workspace encoding as session and project memory data", () => {
    expect(
      getKanaSessionLogPath("session-1", {
        cwd: "/Users/alice/project",
        env: { KANA_HOME: "/home/alice/.kana" },
      }),
    ).toBe("/home/alice/.kana/logs/--Users-alice-project--/session-1.jsonl");
  });

  test("rejects unsafe session IDs", () => {
    expect(() => getKanaSessionLogPath("../session")).toThrow(
      "sessionId must be a non-empty file-name-safe string.",
    );
  });
});
