import { createMessageId, type MessageId } from "@/core";

export type WakeEventOrigin = "agent" | "user";

export type WakeEvent = {
  // A one-shot wake is a future logical input, so its cancellation identity is
  // the same MessageId later carried into the Agent inbox and model history.
  // A repeating wake keeps this ID for the schedule; each delivery gets a
  // fresh MessageId and names the schedule in `scheduleId`.
  readonly id: MessageId;
  readonly sessionId: string;
  readonly dueAt: Date;
  readonly message: string;
  readonly origin: WakeEventOrigin;
  readonly key?: string;
  readonly everyMinutes?: number;
  readonly scheduleId?: MessageId;
};

type ScheduleWakeOptions = {
  readonly sessionId: string;
  readonly afterMinutes: number;
  readonly message: string;
  readonly origin?: WakeEventOrigin;
  readonly key?: string;
  /** Repeat every `afterMinutes` until cancelled. */
  readonly repeat?: boolean;
};

export type WakeScheduler = {
  schedule(options: ScheduleWakeOptions): WakeEvent;
  list(sessionId?: string): WakeEvent[];
  cancel(id: MessageId): boolean;
  subscribe(listener: (event: WakeEvent) => void): () => void;
  subscribeState(listener: () => void): () => void;
  cancelSession(sessionId: string): void;
  dispose(): void;
};

export type CreateWakeSchedulerOptions = {
  readonly now?: () => Date;
  readonly setTimeout?: (callback: () => void, delay: number) => WakeTimer;
  readonly clearTimeout?: (timer: WakeTimer) => void;
  readonly createId?: () => MessageId;
};

type WakeTimer = ReturnType<typeof setTimeout> | number;

type ScheduledWakeEvent = WakeEvent & {
  readonly timer: WakeTimer;
};

// Wake events are intentionally process-local. A stopped Kana instance has no
// responsibility to restore or deliver reminders after it is restarted.
// Repeating wakes advance from their previous due time to avoid drift, and
// skip occurrences missed entirely (e.g. while suspended) instead of replaying.
export function createWakeScheduler(options: CreateWakeSchedulerOptions = {}): WakeScheduler {
  const now = options.now ?? (() => new Date());
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  const createId = options.createId ?? createMessageId;
  const events = new Map<MessageId, ScheduledWakeEvent>();
  const keys = new Map<string, MessageId>();
  const listeners = new Set<(event: WakeEvent) => void>();
  const stateListeners = new Set<() => void>();

  const remove = (id: MessageId): boolean => {
    const event = events.get(id);
    if (!event) {
      return false;
    }

    cancelTimeout(event.timer);
    events.delete(id);
    const key = event.key ? keyFor(event.sessionId, event.key) : undefined;
    if (key && keys.get(key) === id) {
      keys.delete(key);
    }
    return true;
  };

  const publishState = (): void => {
    for (const listener of stateListeners) {
      try {
        listener();
      } catch {
        // Schedule observers cannot change timer creation, replacement, or cleanup.
      }
    }
  };

  return {
    schedule(scheduleOptions) {
      if (scheduleOptions.key) {
        const previousId = keys.get(keyFor(scheduleOptions.sessionId, scheduleOptions.key));
        if (previousId) {
          remove(previousId);
        }
      }

      const dueAt = new Date(now().getTime() + scheduleOptions.afterMinutes * 60_000);
      const id = createId();
      const event: WakeEvent = {
        id,
        sessionId: scheduleOptions.sessionId,
        dueAt,
        message: scheduleOptions.message,
        origin: scheduleOptions.origin ?? "agent",
        key: scheduleOptions.key,
        ...(scheduleOptions.repeat ? { everyMinutes: scheduleOptions.afterMinutes } : {}),
      };
      const arm = (scheduled: WakeEvent): void => {
        const timer = scheduleTimeout(
          () => fire(scheduled),
          Math.max(0, scheduled.dueAt.getTime() - now().getTime()),
        );
        events.set(id, { ...scheduled, timer });
      };
      const fire = (scheduled: WakeEvent): void => {
        if (scheduled.everyMinutes === undefined) {
          remove(id);
        } else {
          const interval = scheduled.everyMinutes * 60_000;
          let next = scheduled.dueAt.getTime() + interval;
          while (next <= now().getTime()) next += interval;
          arm({ ...scheduled, dueAt: new Date(next) });
        }

        const delivered =
          scheduled.everyMinutes === undefined
            ? scheduled
            : { ...scheduled, id: createId(), scheduleId: id };
        for (const listener of listeners) {
          listener(delivered);
        }
        publishState();
      };

      arm(event);
      if (event.key) {
        keys.set(keyFor(event.sessionId, event.key), id);
      }
      publishState();

      return event;
    },
    list(sessionId) {
      return [...events.values()]
        .filter((event) => sessionId === undefined || event.sessionId === sessionId)
        .sort(
          (left, right) =>
            left.dueAt.getTime() - right.dueAt.getTime() || left.id.localeCompare(right.id),
        )
        .map(({ timer: _timer, ...event }) => event);
    },
    cancel(id) {
      const removed = remove(id);
      if (removed) {
        publishState();
      }
      return removed;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    cancelSession(sessionId) {
      let changed = false;
      for (const event of events.values()) {
        if (event.sessionId === sessionId) {
          changed = remove(event.id) || changed;
        }
      }
      if (changed) {
        publishState();
      }
    },
    dispose() {
      const changed = events.size > 0;
      for (const id of events.keys()) {
        remove(id);
      }
      if (changed) {
        publishState();
      }
      listeners.clear();
      stateListeners.clear();
    },
  };
}

function keyFor(sessionId: string, key: string): string {
  return `${sessionId}\u0000${key}`;
}
