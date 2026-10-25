import { describe, expect, test } from "bun:test";
import type { MessageId } from "@/core";
import { createWakeScheduler } from "@/kana";
import { messageIdForTest } from "../../helpers/messages";

describe("wake scheduler", () => {
  test("delivers scheduled events and removes their replacement key", () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const delivered: string[] = [];
    const scheduler = createWakeScheduler({
      createId: () => messageIdForTest("wake-1"),
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

  test("lists process-local events by due time and publishes management changes", () => {
    const now = new Date("2026-08-08T08:00:00.000Z");
    const laterId = messageIdForTest("later");
    const otherId = messageIdForTest("other");
    const soonerId = messageIdForTest("sooner");
    const ids = [laterId, otherId, soonerId];
    const snapshots: MessageId[][] = [];
    const scheduler = createWakeScheduler({
      now: () => now,
      createId: () => ids.shift() as MessageId,
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    scheduler.subscribeState(() => {
      throw new Error("observer unavailable");
    });
    scheduler.subscribeState(() => {
      snapshots.push(scheduler.list("session-a").map((event) => event.id));
    });

    scheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 20,
      message: "later",
      origin: "user",
    });
    scheduler.schedule({ sessionId: "session-b", afterMinutes: 1, message: "other" });
    scheduler.schedule({ sessionId: "session-a", afterMinutes: 5, message: "sooner" });

    expect(scheduler.list("session-a").map((event) => event.id)).toEqual([soonerId, laterId]);
    expect(scheduler.list("session-a").map((event) => event.origin)).toEqual(["agent", "user"]);
    expect(scheduler.cancel(laterId)).toBe(true);
    expect(scheduler.cancel(laterId)).toBe(false);
    expect(scheduler.list("session-a").map((event) => event.id)).toEqual([soonerId]);
    expect(snapshots).toEqual([[laterId], [laterId], [soonerId, laterId], [soonerId]]);

    scheduler.dispose();
  });

  test("repeats from the previous due time with fresh delivery IDs until cancelled", () => {
    let now = new Date("2026-10-25T08:00:00.000Z");
    const timers = new Map<
      number | ReturnType<typeof setTimeout>,
      { run: () => void; delay: number }
    >();
    let nextTimer = 0;
    let nextId = 0;
    const delivered: { id: string; scheduleId?: string; dueAt: string }[] = [];
    const scheduler = createWakeScheduler({
      now: () => now,
      createId: () => messageIdForTest(`id-${++nextId}`),
      setTimeout: (run, delay) => {
        nextTimer += 1;
        timers.set(nextTimer, { run, delay });
        return nextTimer;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    scheduler.subscribe((event) =>
      delivered.push({
        id: event.id,
        scheduleId: event.scheduleId,
        dueAt: event.dueAt.toISOString(),
      }),
    );
    const fireAt = (iso: string) => {
      now = new Date(iso);
      const [id, timer] = [...timers.entries()][0]!;
      timers.delete(id);
      timer.run();
    };

    const event = scheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check in.",
      origin: "user",
      repeat: true,
    });
    expect(event.everyMinutes).toBe(30);
    fireAt("2026-10-25T08:30:05.000Z");
    expect(scheduler.list()).toMatchObject([{ id: event.id, everyMinutes: 30 }]);
    expect(scheduler.list()[0]!.dueAt.toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect([...timers.values()][0]!.delay).toBe(29 * 60_000 + 55_000);
    // A suspended process skips the occurrences it missed instead of replaying them.
    fireAt("2026-10-25T10:10:00.000Z");
    expect(scheduler.list()[0]!.dueAt.toISOString()).toBe("2026-10-25T10:30:00.000Z");

    expect(delivered).toEqual([
      { id: "id-2", scheduleId: event.id, dueAt: "2026-10-25T08:30:00.000Z" },
      { id: "id-3", scheduleId: event.id, dueAt: "2026-10-25T09:00:00.000Z" },
    ]);
    expect(scheduler.cancel(event.id)).toBe(true);
    expect(timers.size).toBe(0);
    expect(scheduler.list()).toEqual([]);
  });
});
