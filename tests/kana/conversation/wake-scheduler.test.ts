import { describe, expect, test } from "bun:test";
import { createWakeScheduler } from "@/kana";

describe("wake scheduler", () => {
  test("delivers scheduled events and removes their replacement key", () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const delivered: string[] = [];
    const scheduler = createWakeScheduler({
      createId: () => "wake-1",
      setTimeout: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    scheduler.subscribe((event) => delivered.push(event.message));

    scheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check the build.",
      key: "build",
    });
    timers.get(1)?.();
    scheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check again.",
      key: "build",
    });

    expect(delivered).toEqual(["Check the build."]);
    expect(timers.size).toBe(1);
  });

  test("replaces only matching keys in the same session and cancels a session's events", () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    let nextTimer = 0;
    const scheduler = createWakeScheduler({
      setTimeout: (callback) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });

    scheduler.schedule({ sessionId: "session-a", afterMinutes: 1, message: "first", key: "check" });
    scheduler.schedule({ sessionId: "session-b", afterMinutes: 1, message: "other", key: "check" });
    scheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 1,
      message: "replacement",
      key: "check",
    });
    scheduler.cancelSession("session-a");

    expect(timers.size).toBe(1);
    scheduler.dispose();
    expect(timers.size).toBe(0);
  });
});
