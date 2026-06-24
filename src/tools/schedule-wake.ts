import { Type } from "@sinclair/typebox";

import type { WakeScheduler } from "@/kana";
import type { Tool } from "./tool";

export const scheduleWakeParameters = Type.Object({
  afterMinutes: Type.Integer({
    minimum: 1,
    maximum: 1_440,
    description: "Minutes to wait before the reminder is delivered (1 to 1440).",
  }),
  message: Type.String({
    minLength: 1,
    maxLength: 4_000,
    description: "The instruction or reminder to send to the agent when the timer expires.",
  }),
  key: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      description:
        "Optional replacement key. A new reminder with the same key replaces the old one.",
    }),
  ),
});

export type ScheduleWakeToolOptions = {
  scheduler: WakeScheduler;
  sessionId: string;
};

export type ScheduleWakeToolResult = {
  id: string;
  dueAt: string;
  key?: string;
};

export function createScheduleWakeTool(
  options: ScheduleWakeToolOptions,
): Tool<typeof scheduleWakeParameters, ScheduleWakeToolResult> {
  return {
    name: "schedule_wake",
    description:
      "Schedule one in-process reminder that starts a new agent turn after a delay. Use it to revisit long-running work while Kana remains open. The reminder is lost if Kana exits.",
    parameters: scheduleWakeParameters,
    execute: (args) => {
      const event = options.scheduler.schedule({
        sessionId: options.sessionId,
        afterMinutes: args.afterMinutes,
        message: args.message,
        key: args.key,
      });
      const result = {
        id: event.id,
        dueAt: event.dueAt.toISOString(),
        key: event.key,
      } satisfies ScheduleWakeToolResult;

      return {
        content: `Scheduled wake event for ${result.dueAt}.`,
        result,
      };
    },
  };
}
