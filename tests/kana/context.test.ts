import { describe, expect, test } from "bun:test";
import { formatKanaEnvironmentContext } from "@/kana";
import { collectKanaEnvironmentContext } from "../../src/kana/context";

describe("Kana environment context", () => {
  test("formats environment context for model input", () => {
    expect(
      formatKanaEnvironmentContext({
        cwd: "/repo",
        platform: "darwin",
        currentDate: "2026-06-12",
        timezone: "Asia/Shanghai",
        currentShell: "/bin/zsh",
      }),
    ).toBe(
      '{"cwd":"/repo","platform":"darwin","currentDate":"2026-06-12","timezone":"Asia/Shanghai","currentShell":"/bin/zsh"}',
    );
  });

  test("reports the selected execution shell", () => {
    const previousShell = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/zsh";
      expect(collectKanaEnvironmentContext().currentShell).toBe("/bin/zsh");
      process.env.SHELL = "/usr/bin/fish";
      expect(collectKanaEnvironmentContext().currentShell).toBe("bash");
      delete process.env.SHELL;
      expect(collectKanaEnvironmentContext().currentShell).toBe("bash");
      process.env.SHELL = " ";
      expect(collectKanaEnvironmentContext().currentShell).toBe("bash");
    } finally {
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
    }
  });
});
