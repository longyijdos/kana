import { createNoopLogger, type Logger } from "@/logging";
import { errorFields } from "@/utils";

// Owners are compared by identity: each binding creates a fresh owner object.
export type TaskOwner = { readonly sessionId: string };

export type TaskSummary = {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
};

export type OwnedTaskEvent<TOwner, TSummary> = {
  readonly type: "started" | "stopping" | "settled" | "observed";
  readonly owner: TOwner;
  readonly task: TSummary;
};

export type OwnedTask<TOwner, TSummary, TState> = {
  readonly owner: TOwner;
  readonly logger: Logger;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  summary: TSummary;
  state: TState;
};

type TaskRecord<TOwner, TSummary, TState> = OwnedTask<TOwner, TSummary, TState> & {
  resolveSettled(): void;
  readonly waiters: Set<() => void>;
  observed: boolean;
  completionPublished: boolean;
};

type Listener<TOwner, TSummary> = {
  readonly owner: TOwner;
  readonly listener: (event: OwnedTaskEvent<TOwner, TSummary>) => void;
};

export type OwnedTaskRegistryOptions<TSummary> = {
  // Prefix for log events and user-facing messages, such as "background_job"
  // and "Background Job".
  readonly logPrefix: string;
  readonly displayName: string;
  readonly maxRetainedTerminal: number;
  isActive(summary: TSummary): boolean;
};

// Tracks owner-scoped tasks through admission, settlement, completion
// observation, and pruning. A completed task is published as `settled` once and
// stays in `context()` until its owner observes it.
export class OwnedTaskRegistry<TOwner extends TaskOwner, TSummary extends TaskSummary, TState> {
  private readonly tasks = new Map<string, TaskRecord<TOwner, TSummary, TState>>();
  private readonly listeners = new Set<Listener<TOwner, TSummary>>();
  private readonly closedOwners = new WeakSet<TOwner>();
  private closing?: Promise<void>;

  constructor(private readonly options: OwnedTaskRegistryOptions<TSummary>) {}

  admit(owner: TOwner, limit: number, logger: Logger, metadata: Record<string, unknown>): void {
    const { logPrefix, displayName } = this.options;
    if (this.closing || this.closedOwners.has(owner)) {
      logger.warn(`${logPrefix}.admission_rejected`, { reason: "owner_closing", ...metadata });
      throw new Error(`${displayName}s are unavailable while the session is closing.`);
    }
    const activeCount = this.owned(owner).filter((task) =>
      this.options.isActive(task.summary),
    ).length;
    if (activeCount >= limit) {
      logger.warn(`${logPrefix}.admission_rejected`, {
        reason: "limit",
        activeCount,
        limit,
        ...metadata,
      });
      throw new Error(`${displayName} limit reached (${activeCount}/${limit}).`);
    }
  }

  add(
    owner: TOwner,
    summary: TSummary,
    state: TState,
    logger: Logger = createNoopLogger(),
  ): OwnedTask<TOwner, TSummary, TState> {
    let resolveSettled!: () => void;
    const task: TaskRecord<TOwner, TSummary, TState> = {
      owner,
      logger,
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      resolveSettled: () => resolveSettled(),
      summary,
      state,
      waiters: new Set(),
      observed: false,
      completionPublished: false,
    };
    this.tasks.set(summary.id, task);
    this.emit({ type: "started", owner, task: summary });
    return task;
  }

  find(owner: TOwner, id: string): OwnedTask<TOwner, TSummary, TState> | undefined {
    const task = this.tasks.get(id);
    return task?.owner === owner ? task : undefined;
  }

  list(owner: TOwner): TSummary[] {
    return sortByStart(this.owned(owner).map((task) => task.summary));
  }

  // Tasks the owner still needs to hear about: active ones and completions it
  // has not observed yet.
  context(owner: TOwner): TSummary[] {
    return sortByStart(
      this.owned(owner)
        .filter((task) => this.options.isActive(task.summary) || !task.observed)
        .map((task) => task.summary),
    );
  }

  // Marks a task terminal. Waiters wake now; the `settled` event is published
  // in a microtask so a caller that observes the result first suppresses it.
  settle(task: OwnedTask<TOwner, TSummary, TState>, summary: TSummary): void {
    const record = task as TaskRecord<TOwner, TSummary, TState>;
    record.summary = summary;
    record.resolveSettled();
    this.notify(record);
    queueMicrotask(() => {
      if (record.observed || record.completionPublished) return;
      record.completionPublished = true;
      this.emit({ type: "settled", owner: record.owner, task: record.summary });
      this.prune(record.owner);
    });
  }

  publishStopping(task: OwnedTask<TOwner, TSummary, TState>): void {
    this.notify(task);
    this.emit({ type: "stopping", owner: task.owner, task: task.summary });
  }

  notify(task: OwnedTask<TOwner, TSummary, TState>): void {
    for (const waiter of [...(task as TaskRecord<TOwner, TSummary, TState>).waiters]) waiter();
  }

  // Resolves true once `ready()` holds, or false after `waitMs`.
  waitUntil(
    task: OwnedTask<TOwner, TSummary, TState>,
    ready: () => boolean,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const waitAborted = `${this.options.displayName} wait aborted.`;
    signal?.throwIfAborted();
    if (ready()) return Promise.resolve(true);
    const { waiters } = task as TaskRecord<TOwner, TSummary, TState>;
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(onChange);
      };
      const onChange = (): void => {
        if (!ready()) return;
        cleanup();
        resolve(true);
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason ?? new Error(waitAborted));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, waitMs);
      waiters.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  observe(owner: TOwner, id: string): void {
    const task = this.tasks.get(id);
    if (task?.owner !== owner || this.options.isActive(task.summary) || task.observed) {
      return;
    }
    task.observed = true;
    this.emit({ type: "observed", owner, task: task.summary });
    this.prune(owner);
  }

  subscribe(
    owner: TOwner,
    listener: (event: OwnedTaskEvent<TOwner, TSummary>) => void,
  ): () => void {
    const registration = { owner, listener };
    this.listeners.add(registration);
    return () => {
      this.listeners.delete(registration);
    };
  }

  // Cancels every task of the owner, then forgets the owner's tasks and
  // listeners. Later admissions for this owner are rejected.
  async closeOwner(
    owner: TOwner,
    source: "session_disposal" | "shutdown",
    cancel: (task: OwnedTask<TOwner, TSummary, TState>) => Promise<unknown>,
  ): Promise<void> {
    this.closedOwners.add(owner);
    const owned = this.owned(owner);
    await Promise.all(
      owned.map((task) =>
        cancel(task).catch((error) => {
          task.logger.warn(`${this.options.logPrefix}.cleanup_failed`, {
            id: task.summary.id,
            phase: source,
            ...errorFields(error),
          });
        }),
      ),
    );
    for (const task of owned) this.tasks.delete(task.summary.id);
    for (const registration of this.listeners) {
      if (registration.owner === owner) this.listeners.delete(registration);
    }
  }

  close(cancel: (task: OwnedTask<TOwner, TSummary, TState>) => Promise<unknown>): Promise<void> {
    this.closing ??= Promise.all(
      [...new Set([...this.tasks.values()].map((task) => task.owner))].map((owner) =>
        this.closeOwner(owner, "shutdown", cancel),
      ),
    ).then(() => {
      this.listeners.clear();
    });
    return this.closing;
  }

  private owned(owner: TOwner): TaskRecord<TOwner, TSummary, TState>[] {
    return [...this.tasks.values()].filter((task) => task.owner === owner);
  }

  private prune(owner: TOwner): void {
    const terminal = this.owned(owner)
      .filter((task) => !this.options.isActive(task.summary))
      .sort(
        (left, right) =>
          (left.summary.finishedAt?.getTime() ?? 0) - (right.summary.finishedAt?.getTime() ?? 0),
      );
    for (const task of terminal.slice(0, -this.options.maxRetainedTerminal)) {
      if (!task.observed) {
        task.observed = true;
        this.emit({ type: "observed", owner: task.owner, task: task.summary });
      }
      this.tasks.delete(task.summary.id);
    }
  }

  private emit(event: OwnedTaskEvent<TOwner, TSummary>): void {
    for (const registration of [...this.listeners]) {
      if (registration.owner !== event.owner) continue;
      try {
        registration.listener(event);
      } catch (error) {
        this.tasks.get(event.task.id)?.logger.warn(`${this.options.logPrefix}.listener_failed`, {
          eventType: event.type,
          ...errorFields(error),
        });
      }
    }
  }
}

function sortByStart<T extends TaskSummary>(summaries: T[]): T[] {
  return summaries.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
}
