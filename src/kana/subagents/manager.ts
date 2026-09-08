import { randomUUID } from "node:crypto";

import type { AgentEndReason } from "@/agent";
import type { Message } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaSubagentProfile } from "./profiles";

const DEFAULT_MAX_RETAINED_TERMINAL_SUBAGENTS = 32;
const MAX_LABEL_LENGTH = 160;

type KanaSubagentStatus =
  | "running"
  | "completed"
  | "errored"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type KanaSubagentOwner = Readonly<{
  sessionId: string;
  instanceId: string;
  cwd: string;
  persistent: boolean;
}>;

export type KanaSubagentSummary = {
  id: string;
  profile: string;
  label: string;
  status: KanaSubagentStatus;
  startedAt: Date;
  finishedAt?: Date;
  model?: { provider: string; model: string };
  terminalReason?: AgentEndReason;
};

export type KanaSubagentSnapshot = KanaSubagentSummary & {
  output: string;
  error?: string;
  waitTimedOut: boolean;
};

export type KanaSubagentInspection = KanaSubagentSnapshot & {
  task: string;
  messages: Message[];
};

export type KanaSubagentRunResult = {
  status: Exclude<KanaSubagentStatus, "running" | "interrupted" | "unknown">;
  output: string;
  messages: Message[];
  model?: { provider: string; model: string };
  terminalReason?: AgentEndReason;
  error?: string;
};

export type KanaSubagentRunContext = {
  agentId: string;
  signal: AbortSignal;
  profile: KanaSubagentProfile;
  task: string;
  spawnToolCallId: string;
  owner: KanaSubagentOwner;
};

type StartKanaSubagentOptions = {
  profile: KanaSubagentProfile;
  task: string;
  spawnToolCallId: string;
  parentSignal?: AbortSignal;
  run(context: KanaSubagentRunContext): Promise<KanaSubagentRunResult>;
};

type WaitKanaSubagentOptions = {
  waitMs?: number;
  signal?: AbortSignal;
};

type CancelKanaSubagentOptions = {
  reason?: string;
  source: "tool" | "tui" | "parent_turn" | "session_disposal" | "shutdown";
};

type KanaSubagentEvent = {
  type: "started" | "settled";
  owner: KanaSubagentOwner;
  subagent: KanaSubagentSummary;
};

export type KanaSubagentClient = {
  readonly owner: KanaSubagentOwner;
  start(options: StartKanaSubagentOptions): KanaSubagentSummary;
  list(): KanaSubagentSummary[];
  context(): KanaSubagentSummary[];
  wait(agentId: string, options?: WaitKanaSubagentOptions): Promise<KanaSubagentSnapshot>;
  inspect(agentId: string): KanaSubagentInspection | undefined;
  cancel(agentId: string, options: CancelKanaSubagentOptions): Promise<KanaSubagentSummary>;
  subscribe(listener: (event: KanaSubagentEvent) => void): () => void;
  close(source?: "session_disposal" | "shutdown"): Promise<void>;
};

type SubagentRecord = {
  owner: KanaSubagentOwner;
  logger: Logger;
  profile: KanaSubagentProfile;
  task: string;
  summary: KanaSubagentSummary;
  controller: AbortController;
  settlement: Promise<void>;
  resolveSettlement(): void;
  output: string;
  messages: Message[];
  error?: string;
  waiters: Set<() => void>;
  parentSignal?: AbortSignal;
  onParentAbort?: () => void;
};

type ListenerRegistration = {
  ownerInstanceId: string;
  listener: (event: KanaSubagentEvent) => void;
};

export type KanaSubagentManagerOptions = {
  maxRetainedTerminalSubagents?: number;
  loadArchived?: (owner: KanaSubagentOwner) => KanaSubagentInspection[];
};

export class KanaSubagentManager {
  private readonly records = new Map<string, SubagentRecord>();
  private readonly listeners = new Set<ListenerRegistration>();
  private readonly closedOwners = new Set<string>();
  private readonly maxRetainedTerminalSubagents: number;
  private closePromise?: Promise<void>;

  constructor(private readonly options: KanaSubagentManagerOptions = {}) {
    this.maxRetainedTerminalSubagents = readPositiveInteger(
      options.maxRetainedTerminalSubagents,
      DEFAULT_MAX_RETAINED_TERMINAL_SUBAGENTS,
      "maxRetainedTerminalSubagents",
    );
  }

  createOwner(options: { sessionId: string; cwd: string; persistent: boolean }): KanaSubagentOwner {
    if (!options.sessionId.trim()) throw new Error("Subagent owner session ID cannot be empty.");
    return Object.freeze({
      ...options,
      sessionId: options.sessionId.trim(),
      instanceId: randomUUID(),
    });
  }

  bind(
    owner: KanaSubagentOwner,
    options: { maxLive: number; logger?: Logger },
  ): KanaSubagentClient {
    const maxLive = readPositiveInteger(options.maxLive, undefined, "maxLive");
    const logger = options.logger ?? createNoopLogger();
    return Object.freeze({
      owner,
      start: (startOptions) => this.start(owner, maxLive, logger, startOptions),
      list: () => this.list(owner),
      context: () => this.context(owner),
      wait: (agentId, waitOptions) => this.wait(owner, agentId, waitOptions),
      inspect: (agentId) => this.inspect(owner, agentId),
      cancel: (agentId, cancelOptions) => this.cancel(owner, agentId, cancelOptions),
      subscribe: (listener) => this.subscribe(owner, listener),
      close: (source = "session_disposal") => this.closeOwner(owner, source),
    });
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      const owners = uniqueOwners([...this.records.values()].map((record) => record.owner));
      this.closePromise = Promise.all(
        owners.map((owner) => this.closeOwner(owner, "shutdown")),
      ).then(() => {
        this.listeners.clear();
      });
    }
    return this.closePromise;
  }

  private start(
    owner: KanaSubagentOwner,
    maxLive: number,
    logger: Logger,
    options: StartKanaSubagentOptions,
  ): KanaSubagentSummary {
    if (this.closePromise || this.closedOwners.has(owner.instanceId)) {
      throw new Error("Subagents are unavailable while the session is closing.");
    }
    if (options.parentSignal?.aborted) throw new Error("Subagent spawn was cancelled.");
    const liveCount = [...this.records.values()].filter(
      (record) =>
        record.owner.instanceId === owner.instanceId && record.summary.status === "running",
    ).length;
    if (liveCount >= maxLive) {
      logger.warn("subagent.admission_rejected", { reason: "live_limit", liveCount, maxLive });
      throw new Error(`Subagent limit reached (${liveCount}/${maxLive}).`);
    }

    const id = `agent_${randomUUID()}`;
    const summary: KanaSubagentSummary = {
      id,
      profile: options.profile.name,
      label: createLabel(options.profile.name, options.task),
      status: "running",
      startedAt: new Date(),
    };
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const record: SubagentRecord = {
      owner,
      logger,
      profile: structuredClone(options.profile),
      task: options.task,
      summary,
      controller: new AbortController(),
      settlement,
      resolveSettlement,
      output: "",
      messages: [],
      waiters: new Set(),
      parentSignal: options.parentSignal,
    };
    if (options.parentSignal) {
      record.onParentAbort = () => {
        void this.cancel(owner, id, {
          source: "parent_turn",
          reason: "Parent Agent turn was cancelled.",
        });
      };
      options.parentSignal.addEventListener("abort", record.onParentAbort, { once: true });
    }
    this.records.set(id, record);
    logger.info("subagent.started", { agentId: id, profile: options.profile.name });
    this.emit({ type: "started", owner, subagent: cloneSummary(summary) });

    void Promise.resolve()
      .then(() =>
        options.run({
          agentId: id,
          signal: record.controller.signal,
          profile: structuredClone(options.profile),
          task: options.task,
          spawnToolCallId: options.spawnToolCallId,
          owner,
        }),
      )
      .then(
        (result) => this.finalize(record, result),
        (error) =>
          this.finalize(record, {
            status: record.controller.signal.aborted ? "cancelled" : "errored",
            output: "",
            messages: [],
            error: formatError(error),
          }),
      );
    return cloneSummary(summary);
  }

  private list(owner: KanaSubagentOwner): KanaSubagentSummary[] {
    const current = [...this.records.values()]
      .filter((record) => record.owner.instanceId === owner.instanceId)
      .map((record) => cloneSummary(record.summary));
    const ids = new Set(current.map((summary) => summary.id));
    const archived = this.loadArchived(owner)
      .filter((inspection) => !ids.has(inspection.id))
      .map(cloneSummary);
    return [...archived, ...current].sort(
      (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
    );
  }

  private context(owner: KanaSubagentOwner): KanaSubagentSummary[] {
    return [...this.records.values()]
      .filter((record) => record.owner.instanceId === owner.instanceId)
      .map((record) => cloneSummary(record.summary))
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  private async wait(
    owner: KanaSubagentOwner,
    agentId: string,
    options: WaitKanaSubagentOptions = {},
  ): Promise<KanaSubagentSnapshot> {
    const record = this.findOwned(owner, agentId);
    if (!record) {
      const archived = this.inspect(owner, agentId);
      return archived ?? unknownSnapshot(agentId);
    }
    const waitMs = readNonNegativeInteger(options.waitMs, 0, "waitMs");
    let waitTimedOut = false;
    if (record.summary.status === "running" && waitMs > 0) {
      waitTimedOut = !(await this.waitForSettlement(record, waitMs, options.signal));
    }
    return snapshotRecord(record, waitTimedOut);
  }

  private inspect(owner: KanaSubagentOwner, agentId: string): KanaSubagentInspection | undefined {
    const record = this.findOwned(owner, agentId);
    if (record) {
      return {
        ...snapshotRecord(record, false),
        task: record.task,
        messages: structuredClone(record.messages),
      };
    }
    return this.loadArchived(owner).find((inspection) => inspection.id === agentId);
  }

  private async cancel(
    owner: KanaSubagentOwner,
    agentId: string,
    options: CancelKanaSubagentOptions,
  ): Promise<KanaSubagentSummary> {
    const record = this.findOwned(owner, agentId);
    if (!record) {
      return this.inspect(owner, agentId) ?? unknownSummary(agentId);
    }
    if (record.summary.status !== "running") return cloneSummary(record.summary);
    record.logger.info("subagent.cancellation_requested", {
      agentId,
      profile: record.profile.name,
      source: options.source,
    });
    record.controller.abort(options.reason ?? "Subagent cancellation requested.");
    this.wakeWaiters(record);
    await record.settlement;
    return cloneSummary(record.summary);
  }

  private subscribe(
    owner: KanaSubagentOwner,
    listener: (event: KanaSubagentEvent) => void,
  ): () => void {
    const registration = { ownerInstanceId: owner.instanceId, listener };
    this.listeners.add(registration);
    return () => this.listeners.delete(registration);
  }

  private async closeOwner(
    owner: KanaSubagentOwner,
    source: "session_disposal" | "shutdown",
  ): Promise<void> {
    this.closedOwners.add(owner.instanceId);
    const records = [...this.records.values()].filter(
      (record) => record.owner.instanceId === owner.instanceId,
    );
    await Promise.all(
      records.map((record) =>
        this.cancel(owner, record.summary.id, { source }).catch((error) => {
          record.logger.warn("subagent.cleanup_failed", {
            agentId: record.summary.id,
            phase: source,
            errorType: getErrorType(error),
          });
        }),
      ),
    );
    for (const record of records) this.records.delete(record.summary.id);
    for (const registration of this.listeners) {
      if (registration.ownerInstanceId === owner.instanceId) this.listeners.delete(registration);
    }
  }

  private finalize(record: SubagentRecord, result: KanaSubagentRunResult): void {
    if (record.summary.status !== "running") return;
    record.summary.status = record.controller.signal.aborted ? "cancelled" : result.status;
    record.summary.finishedAt = new Date();
    record.summary.model = result.model;
    record.summary.terminalReason = result.terminalReason;
    record.output = result.output;
    record.messages = structuredClone(result.messages);
    record.error = result.error;
    if (record.parentSignal && record.onParentAbort) {
      record.parentSignal.removeEventListener("abort", record.onParentAbort);
    }
    record.resolveSettlement();
    this.wakeWaiters(record);
    const level = result.status === "errored" ? "warn" : "info";
    record.logger[level]("subagent.settled", {
      agentId: record.summary.id,
      profile: record.profile.name,
      status: result.status,
      terminalReason: result.terminalReason,
    });
    this.emit({ type: "settled", owner: record.owner, subagent: cloneSummary(record.summary) });
    this.prune(record.owner);
  }

  private waitForSettlement(
    record: SubagentRecord,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("Subagent wait aborted."));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (changed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        record.waiters.delete(onSettled);
        resolve(changed);
      };
      const onSettled = (): void => finish(true);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(onSettled);
        reject(signal?.reason ?? new Error("Subagent wait aborted."));
      };
      const timer = setTimeout(() => finish(false), waitMs);
      record.waiters.add(onSettled);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (record.summary.status !== "running") finish(true);
    });
  }

  private wakeWaiters(record: SubagentRecord): void {
    for (const waiter of [...record.waiters]) waiter();
  }

  private findOwned(owner: KanaSubagentOwner, id: string): SubagentRecord | undefined {
    const record = this.records.get(id);
    return record?.owner.instanceId === owner.instanceId ? record : undefined;
  }

  private loadArchived(owner: KanaSubagentOwner): KanaSubagentInspection[] {
    if (!owner.persistent) return [];
    try {
      return this.options.loadArchived?.(owner).map(cloneInspection) ?? [];
    } catch {
      return [];
    }
  }

  private emit(event: KanaSubagentEvent): void {
    for (const registration of this.listeners) {
      if (registration.ownerInstanceId !== event.owner.instanceId) continue;
      try {
        registration.listener({ ...event, subagent: cloneSummary(event.subagent) });
      } catch {
        // Manager listeners are observational and cannot affect child lifecycle.
      }
    }
  }

  private prune(owner: KanaSubagentOwner): void {
    const terminal = [...this.records.values()]
      .filter(
        (record) =>
          record.owner.instanceId === owner.instanceId && record.summary.status !== "running",
      )
      .sort(
        (left, right) =>
          (left.summary.finishedAt?.getTime() ?? 0) - (right.summary.finishedAt?.getTime() ?? 0),
      );
    for (const record of terminal.slice(0, -this.maxRetainedTerminalSubagents)) {
      this.records.delete(record.summary.id);
    }
  }
}

function snapshotRecord(record: SubagentRecord, waitTimedOut: boolean): KanaSubagentSnapshot {
  return {
    ...cloneSummary(record.summary),
    output: record.output,
    ...(record.error === undefined ? {} : { error: record.error }),
    waitTimedOut,
  };
}

function cloneSummary(summary: KanaSubagentSummary): KanaSubagentSummary {
  return {
    ...summary,
    startedAt: new Date(summary.startedAt),
    ...(summary.finishedAt === undefined ? {} : { finishedAt: new Date(summary.finishedAt) }),
    ...(summary.model === undefined ? {} : { model: { ...summary.model } }),
  };
}

function cloneInspection(value: KanaSubagentInspection): KanaSubagentInspection {
  return {
    ...cloneSummary(value),
    output: value.output,
    error: value.error,
    waitTimedOut: value.waitTimedOut,
    task: value.task,
    messages: structuredClone(value.messages),
  };
}

function unknownSummary(id: string): KanaSubagentSummary {
  return {
    id,
    profile: "unknown",
    label: "Unknown subagent",
    status: "unknown",
    startedAt: new Date(0),
  };
}

function unknownSnapshot(id: string): KanaSubagentSnapshot {
  return { ...unknownSummary(id), output: "", waitTimedOut: false };
}

function createLabel(profile: string, task: string): string {
  const normalized = task.trim().replace(/\s+/g, " ");
  const label = `${profile}: ${normalized}`;
  return label.length <= MAX_LABEL_LENGTH ? label : `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`;
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number | undefined,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || (resolved ?? 0) <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return resolved as number;
}

function readNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0)
    throw new Error(`${name} must be a non-negative integer.`);
  return resolved;
}

function uniqueOwners(owners: KanaSubagentOwner[]): KanaSubagentOwner[] {
  return [...new Map(owners.map((owner) => [owner.instanceId, owner])).values()];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
