import { describe, expect, test } from "bun:test";
import {
  encodeTerminalNotification,
  resolveNotificationBackend,
  sanitizeTerminalNotificationText,
} from "../src/tui/runtime/notifications";

describe("terminal notifications", () => {
  test("uses an explicit backend without inspecting the environment", () => {
    expect(resolveNotificationBackend("osc9", { KITTY_WINDOW_ID: "3" })).toBe("osc9");
  });

  test("selects the most capable detected backend", () => {
    expect(resolveNotificationBackend("auto", { KITTY_WINDOW_ID: "3" })).toBe("kitty");
    expect(resolveNotificationBackend("auto", { TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
    expect(resolveNotificationBackend("auto", { VTE_VERSION: "7800" })).toBe("osc777");
    expect(resolveNotificationBackend("auto", {})).toBe("bell");
  });

  test("encodes the bell and disabled backends", () => {
    const notification = { title: "Kana", urgency: "normal" } as const;

    expect(encodeTerminalNotification(notification, "bell")).toBe("\x07");
    expect(encodeTerminalNotification(notification, "off")).toBeUndefined();
  });

  test("encodes OSC 9 notifications", () => {
    expect(
      encodeTerminalNotification(
        { title: "Kana", body: "Agent completed", urgency: "normal" },
        "osc9",
      ),
    ).toBe("\x1b]9;Kana: Agent completed\x1b\\");
  });

  test("encodes OSC 777 notifications with distinct title and body fields", () => {
    expect(
      encodeTerminalNotification(
        { title: "Kana; status", body: "Needs; approval", urgency: "critical" },
        "osc777",
      ),
    ).toBe("\x1b]777;notify;Kana, status;Needs, approval\x1b\\");
  });

  test("encodes kitty title and body chunks with a notification id", () => {
    expect(
      encodeTerminalNotification(
        { title: "Kana", body: "Needs approval", urgency: "critical" },
        "kitty",
        42,
      ),
    ).toBe("\x1b]99;i=42:d=0;Kana\x1b\\\x1b]99;i=42:p=body;Needs approval\x1b\\");
  });

  test("removes terminal control characters from notification text", () => {
    expect(sanitizeTerminalNotificationText("Kana\x1b]9;bad\x07\r\nreply")).toBe(
      "Kana ]9;bad reply",
    );
    expect(
      encodeTerminalNotification(
        { title: "Kana\x1b]9;bad", body: "Needs\napproval", urgency: "critical" },
        "osc9",
      ),
    ).toBe("\x1b]9;Kana ]9;bad: Needs approval\x1b\\");
  });
});
