import { describe, expect, test } from "bun:test";
import { createWakeScheduler } from "@/kana";
import { createScheduleWakeTool } from "@/tools";

describe("schedule_wake tool", () => {
  test("registers a process-local reminder for its session", async () => {
    const scheduled: Array<{ sessionId: string; message: string }> = [];
    const scheduler = createWakeScheduler({
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    scheduler.subscribe((event) => scheduled.push(event));
    const tool = createScheduleWakeTool({ scheduler, sessionId: "session-a" });

    const output = await tool.execute(
      { afterMinutes: 30, message: "Check the long-running task." },
      { toolCallId: "call-1", update() {} },
    );

    expect(output).toMatchObject({
      content: expect.stringContaining("Scheduled wake event for"),
      result: { id: expect.any(String), dueAt: expect.any(String) },
    });
    expect(scheduled).toEqual([]);
    scheduler.dispose();
  });
});
