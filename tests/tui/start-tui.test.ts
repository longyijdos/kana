import { describe, expect, test } from "bun:test";
import { prepareTuiTheme, startTui } from "../../src/tui/start-tui";
import { KANA_TUI_THEME } from "../../src/tui/themes";

describe("TUI startup", () => {
  test("rejects saved-session entry points in clean mode", async () => {
    await expect(
      startTui({ launchMode: "clean", resumeSessionId: "saved-session" }),
    ).rejects.toThrow("Clean mode cannot resume saved sessions because its session is temporary.");
    await expect(startTui({ launchMode: "clean", showResumePicker: true })).rejects.toThrow(
      "Clean mode cannot resume saved sessions because its session is temporary.",
    );
  });

  test("closes the host when the configured theme cannot be prepared", async () => {
    const events: string[] = [];
    let closed = false;

    await expect(
      prepareTuiTheme("broken", {
        logger: {
          info(event) {
            events.push(event);
          },
          error(event) {
            events.push(event);
          },
        },
        close: async () => {
          closed = true;
        },
        load: () => {
          throw new Error("broken theme");
        },
        apply: () => {},
      }),
    ).rejects.toThrow("broken theme");

    expect(closed).toBe(true);
    expect(events).toEqual(["tui.theme_prepare_failed"]);
  });

  test("applies and reports a resolved theme before app construction", async () => {
    const events: string[] = [];
    let applied = false;

    const theme = await prepareTuiTheme("kana", {
      logger: {
        info(event) {
          events.push(event);
        },
        error(event) {
          events.push(event);
        },
      },
      close: async () => {
        throw new Error("must not close");
      },
      load: () => KANA_TUI_THEME,
      apply: () => {
        applied = true;
      },
    });

    expect(theme).toBe(KANA_TUI_THEME);
    expect(applied).toBe(true);
    expect(events).toEqual(["tui.theme_loaded"]);
  });
});
