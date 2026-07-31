export type WakeEvent = {
  id: string;
  sessionId: string;
  dueAt: Date;
  message: string;
  key?: string;
};

export type ScheduleWakeOptions = {
  sessionId: string;
  afterMinutes: number;
  message: string;
  key?: string;
};

export type WakeScheduler = {
  schedule(options: ScheduleWakeOptions): WakeEvent;
  subscribe(listener: (event: WakeEvent) => void): () => void;
  cancelSession(sessionId: string): void;
  dispose(): void;
};

export type CreateWakeSchedulerOptions = {
  now?: () => Date;
  setTimeout?: (callback: () => void, delay: number) => WakeTimer;
  clearTimeout?: (timer: WakeTimer) => void;
  createId?: () => string;
};

type WakeTimer = ReturnType<typeof setTimeout> | number;

type ScheduledWakeEvent = WakeEvent & {
  timer: WakeTimer;
};

// Wake events are intentionally process-local. A stopped Kana instance has no
// responsibility to restore or deliver reminders after it is restarted.
export function createWakeScheduler(options: CreateWakeSchedulerOptions = {}): WakeScheduler {
  const now = options.now ?? (() => new Date());
  const scheduleTimeout = options.setTimeout ?? setTimeout;
  const cancelTimeout = options.clearTimeout ?? clearTimeout;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const events = new Map<string, ScheduledWakeEvent>();
  const keys = new Map<string, string>();
  const listeners = new Set<(event: WakeEvent) => void>();

  const cancel = (id: string): void => {
    const event = events.get(id);
    if (!event) {
      return;
    }

    cancelTimeout(event.timer);
    events.delete(id);
    const key = event.key ? keyFor(event.sessionId, event.key) : undefined;
    if (key && keys.get(key) === id) {
      keys.delete(key);
    }
  };

  return {
    schedule(scheduleOptions) {
      if (scheduleOptions.key) {
        const previousId = keys.get(keyFor(scheduleOptions.sessionId, scheduleOptions.key));
        if (previousId) {
          cancel(previousId);
        }
      }

      const dueAt = new Date(now().getTime() + scheduleOptions.afterMinutes * 60_000);
      const id = createId();
      const event: WakeEvent = {
        id,
        sessionId: scheduleOptions.sessionId,
        dueAt,
        message: scheduleOptions.message,
        key: scheduleOptions.key,
      };
      const timer = scheduleTimeout(
        () => {
          events.delete(id);
          const key = event.key ? keyFor(event.sessionId, event.key) : undefined;
          if (key && keys.get(key) === id) {
            keys.delete(key);
          }

          for (const listener of listeners) {
            listener(structuredClone(event));
          }
        },
        Math.max(0, dueAt.getTime() - now().getTime()),
      );

      events.set(id, { ...event, timer });
      if (event.key) {
        keys.set(keyFor(event.sessionId, event.key), id);
      }

      return structuredClone(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelSession(sessionId) {
      for (const event of events.values()) {
        if (event.sessionId === sessionId) {
          cancel(event.id);
        }
      }
    },
    dispose() {
      for (const id of events.keys()) {
        cancel(id);
      }
      listeners.clear();
    },
  };
}

function keyFor(sessionId: string, key: string): string {
  return `${sessionId}\u0000${key}`;
}
