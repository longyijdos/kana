import { describe, expect, test } from "bun:test";
import {
  createCancelWakeTool,
  createListWakesTool,
  createScheduleWakeTool,
  createWakeScheduler,
} from "@/kana";

describe("Kana schedule_wake tool", () => {
  test("registers a process-local reminder for its session", async () => {
    const scheduled: Array<{ sessionId: string; message: string }> = [];
    const scheduler = createWakeScheduler({
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    scheduler.subscribe((event) => scheduled.push(event));
    const tool = createScheduleWakeTool({ scheduler, sessionId: "session-a" });

    const output = await tool.execute(
      { afterMinutes: 30, message: "Check the long-running task.", key: "check-task" },
      { toolCallId: "call-1", update() {} },
    );

    expect(output).toEqual({
      content: expect.stringContaining("Scheduled wake event for"),
      result: { id: expect.any(String), dueAt: expect.any(String) },
    });
    expect(scheduler.list("session-a")).toMatchObject([{ origin: "agent", key: "check-task" }]);
    expect(scheduled).toEqual([]);
    scheduler.dispose();
  });
  test("lists session timers and cancels a repeating timer by its stable ID", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    let nextTimer = 0;
    const scheduler = createWakeScheduler({
      setTimeout: (callback) => {
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const options = { scheduler, sessionId: "session-a" };
    const context = { toolCallId: "call-1", update() {} };
    const other = scheduler.schedule({
      sessionId: "session-b",
      afterMinutes: 1,
      message: "Private",
    });
    const schedule = createScheduleWakeTool(options);
    const list = createListWakesTool(options);
    const cancel = createCancelWakeTool(options);
    const output = await schedule.execute(
      { afterMinutes: 5, message: "Check progress", repeat: true, key: "progress" },
      context,
    );
    const [event] = scheduler.list("session-a");
    expect(event).toBeDefined();
    expect(output).toMatchObject({ result: { id: event!.id, everyMinutes: 5 } });
    expect(await list.execute({}, context)).toEqual({
      content: expect.any(String),
      result: {
        wakes: [
          {
            id: event!.id,
            dueAt: event!.dueAt.toISOString(),
            message: "Check progress",
            origin: "agent",
            everyMinutes: 5,
            key: "progress",
          },
        ],
      },
    });
    expect(await cancel.execute({ id: other.id }, context)).toMatchObject({
      result: { cancelled: false },
    });
    expect(scheduler.list("session-b")).toHaveLength(1);

    timers.get(2)?.();
    expect(scheduler.list("session-a")[0]!.id).toBe(event!.id);
    expect(await cancel.execute({ id: event!.id }, context)).toMatchObject({
      result: { cancelled: true },
    });
    expect(await cancel.execute({ id: event!.id }, context)).toMatchObject({
      result: { cancelled: false },
    });
    expect(await list.execute({}, context)).toMatchObject({ result: { wakes: [] } });
    expect(timers.has(3)).toBe(false);
    scheduler.dispose();
  });
});
