import { Type } from "typebox";
import type { Tool } from "@/tools";
import { strictObject } from "@/tools";
import type { WakeScheduler } from "../conversation/wake-scheduler";

export const scheduleWakeParameters = strictObject({
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
  repeat: Type.Optional(
    Type.Boolean({ description: "Repeat every afterMinutes until cancelled. Defaults to false." }),
  ),
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
  everyMinutes?: number;
};

export function createScheduleWakeTool(
  options: ScheduleWakeToolOptions,
): Tool<typeof scheduleWakeParameters, ScheduleWakeToolResult> {
  return {
    name: "schedule_wake",
    description:
      "Schedule an in-process reminder that starts a new agent turn after a delay, optionally repeating every afterMinutes until cancelled. Use it to revisit long-running work while Kana remains open. Reminders are lost if Kana exits.",
    parameters: scheduleWakeParameters,
    outputSchema: Type.Object({
      id: Type.String(),
      dueAt: Type.String(),
      everyMinutes: Type.Optional(Type.Integer()),
    }),
    execute: (args) => {
      const event = options.scheduler.schedule({
        sessionId: options.sessionId,
        afterMinutes: args.afterMinutes,
        message: args.message,
        origin: "agent",
        key: args.key,
        repeat: args.repeat,
      });
      const result = {
        id: event.id,
        dueAt: event.dueAt.toISOString(),
        ...(event.everyMinutes === undefined ? {} : { everyMinutes: event.everyMinutes }),
      } satisfies ScheduleWakeToolResult;

      return {
        content: `Scheduled wake event for ${result.dueAt}. ID: ${result.id}.${event.everyMinutes === undefined ? "" : ` Repeats every ${event.everyMinutes} minutes.`}`,
        result,
      };
    },
  };
}

const listWakesParameters = strictObject({});
const cancelWakeParameters = strictObject({
  id: Type.String({
    minLength: 1,
    description: "The schedule ID returned by schedule_wake or list_wakes.",
  }),
});

type ListedWake = {
  readonly id: string;
  readonly dueAt: string;
  readonly message: string;
  readonly origin: "agent" | "user";
  readonly key?: string;
  readonly everyMinutes?: number;
};

export function createListWakesTool(
  options: ScheduleWakeToolOptions,
): Tool<typeof listWakesParameters, { wakes: readonly ListedWake[] }> {
  return {
    name: "list_wakes",
    description:
      "List the current session's active in-process reminder timers, including their IDs and repeat intervals. Does not include already delivered or queued messages.",
    parameters: listWakesParameters,
    outputSchema: Type.Object({
      wakes: Type.Array(
        Type.Object({
          id: Type.String(),
          dueAt: Type.String(),
          message: Type.String(),
          origin: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
          key: Type.Optional(Type.String()),
          everyMinutes: Type.Optional(Type.Integer()),
        }),
      ),
    }),
    execute: () => {
      const wakes = options.scheduler.list(options.sessionId).map(
        (event): ListedWake => ({
          id: event.id,
          dueAt: event.dueAt.toISOString(),
          message: event.message,
          origin: event.origin,
          ...(event.key === undefined ? {} : { key: event.key }),
          ...(event.everyMinutes === undefined ? {} : { everyMinutes: event.everyMinutes }),
        }),
      );
      const result = { wakes };
      return { content: JSON.stringify(result, null, 2), result };
    },
  };
}

export function createCancelWakeTool(
  options: ScheduleWakeToolOptions,
): Tool<typeof cancelWakeParameters, { cancelled: boolean }> {
  return {
    name: "cancel_wake",
    description:
      "Cancel one reminder timer in the current session by schedule ID. Stops future triggers only; messages already delivered or queued are unaffected.",
    parameters: cancelWakeParameters,
    outputSchema: Type.Object({ cancelled: Type.Boolean() }),
    execute: (args) => {
      const event = options.scheduler.list(options.sessionId).find((wake) => wake.id === args.id);
      const cancelled = event !== undefined && options.scheduler.cancel(event.id);
      return {
        content: cancelled
          ? "Reminder timer cancelled."
          : "Reminder timer not found in this session.",
        result: { cancelled },
      };
    },
  };
}
