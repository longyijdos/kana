import { describe, expect, test } from "bun:test";
import { formatKanaEnvironmentContext } from "@/kana";

describe("Kana environment context", () => {
  test("formats environment context for model input", () => {
    expect(
      formatKanaEnvironmentContext({
        cwd: "/repo",
        platform: "darwin",
        currentDate: "2026-06-12",
        timezone: "Asia/Shanghai",
      }),
    ).toBe(
      '{"cwd":"/repo","platform":"darwin","currentDate":"2026-06-12","timezone":"Asia/Shanghai"}',
    );
  });
});
