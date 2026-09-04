import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

  test("fails cleanly when the configured theme is invalid", async () => {
    const home = path.join(os.tmpdir(), `kana-starttui-test-${process.pid}-${Date.now()}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "config.toml"), '[tui]\ntheme = "missing-theme"\n');

    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/main.ts", "--clean"],
      env: { ...process.env, KANA_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });

    Bun.spawnSync(["rm", "-rf", home]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('Unknown TUI theme "missing-theme"');
  });
});
