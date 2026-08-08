export type WakeEventOrigin = "agent" | "user";

export type WakeEvent = {
  id: string;
  sessionId: string;
  dueAt: Date;
  message: string;
  origin: WakeEventOrigin;
  key?: string;
};

export type ScheduleWakeOptions = {
  sessionId: string;
  afterMinutes: number;
  message: string;
  origin?: WakeEventOrigin;
  key?: string;
};

export type WakeScheduler = {
  schedule(options: ScheduleWakeOptions): WakeEvent;
  list(sessionId?: string): WakeEvent[];
  cancel(id: string): boolean;
  subscribe(listener: (event: WakeEvent) => void): () => void;
  subscribeState(listener: () => void): () => void;
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
  const stateListeners = new Set<() => void>();

  const remove = (id: string): boolean => {
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
      };
      const timer = scheduleTimeout(
        () => {
          remove(id);

          for (const listener of listeners) {
            listener(structuredClone(event));
          }
          publishState();
        },
        Math.max(0, dueAt.getTime() - now().getTime()),
      );

      events.set(id, { ...event, timer });
      if (event.key) {
        keys.set(keyFor(event.sessionId, event.key), id);
      }
      publishState();

      return structuredClone(event);
    },
    list(sessionId) {
      return [...events.values()]
        .filter((event) => sessionId === undefined || event.sessionId === sessionId)
        .sort(
          (left, right) =>
            left.dueAt.getTime() - right.dueAt.getTime() || left.id.localeCompare(right.id),
        )
        .map(({ timer: _timer, ...event }) => structuredClone(event));
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
