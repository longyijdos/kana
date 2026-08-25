import { randomUUID } from "node:crypto";

import { createNoopLogger, type Logger } from "@/logging";

const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_READ_BYTES = 20 * 1024;
const DEFAULT_MAX_RETAINED_TERMINAL_JOBS = 32;
const MAX_BACKGROUND_JOB_LABEL_BYTES = 512;

export type BackgroundJobStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

export type BackgroundJobTerminalStatus = Exclude<BackgroundJobStatus, "running" | "stopping">;

export type BackgroundJobOutputStream = "stdout" | "stderr";

type BackgroundJobOwner = Readonly<{
  sessionId: string;
  instanceId: string;
}>;

export type BackgroundJobSummary = {
  id: string;
  kind: string;
  label: string;
  cwd?: string;
  status: BackgroundJobStatus;
  startedAt: Date;
  finishedAt?: Date;
  exitCode: number | null;
};

export type BackgroundJobOutputChunk = {
  stream: BackgroundJobOutputStream;
  text: string;
};

export type BackgroundJobOutputSnapshot = {
  jobId: string;
  status: BackgroundJobStatus;
  chunks: BackgroundJobOutputChunk[];
  hasMore: boolean;
  droppedBytes: number;
  waitTimedOut: boolean;
  exitCode: number | null;
};

export type BackgroundJobPeekSnapshot = {
  jobId: string;
  status: BackgroundJobStatus;
  chunks: BackgroundJobOutputChunk[];
  truncated: boolean;
  droppedBytes: number;
  exitCode: number | null;
};

type BackgroundJobProducerResult = {
  status: BackgroundJobTerminalStatus;
  exitCode: number | null;
};

export type BackgroundJobCompletionEvent = {
  type: "completed" | "observed";
  owner: BackgroundJobOwner;
  job: BackgroundJobSummary;
};

type BackgroundJobEventListener = (event: BackgroundJobCompletionEvent) => void;

type BackgroundJobProducerContext = {
  signal: AbortSignal;
  write(stream: BackgroundJobOutputStream, text: string): void;
};

type StartBackgroundJobOptions = {
  kind: string;
  label: string;
  cwd?: string;
  run(context: BackgroundJobProducerContext): Promise<BackgroundJobProducerResult>;
};

type ReadBackgroundJobOutputOptions = {
  waitMs?: number;
  signal?: AbortSignal;
};

type KillBackgroundJobOptions = {
  reason?: string;
  source: "tool" | "tui" | "session_disposal" | "shutdown";
};

export type BackgroundJobClient = {
  readonly owner: BackgroundJobOwner;
  start(options: StartBackgroundJobOptions): BackgroundJobSummary;
  list(): BackgroundJobSummary[];
  context(): BackgroundJobSummary[];
  read(
    jobId: string,
    options?: ReadBackgroundJobOutputOptions,
  ): Promise<BackgroundJobOutputSnapshot>;
  peek(jobId: string): BackgroundJobPeekSnapshot;
  kill(jobId: string, options: KillBackgroundJobOptions): Promise<BackgroundJobSummary>;
  observe(jobId: string): void;
  subscribe(listener: BackgroundJobEventListener): () => void;
  close(source?: "session_disposal" | "shutdown"): Promise<void>;
};

type BindBackgroundJobOwnerOptions = {
  maxConcurrent: number;
  logger?: Logger;
};

type OutputChunk = BackgroundJobOutputChunk & {
  sequence: number;
  byteLength: number;
};

type JobRecord = {
  owner: BackgroundJobOwner;
  logger: Logger;
  summary: BackgroundJobSummary;
  controller: AbortController;
  settlement: Promise<void>;
  resolveSettlement(): void;
  chunks: OutputChunk[];
  retainedBytes: number;
  totalDroppedBytes: number;
  unreadDroppedBytes: number;
  nextSequence: number;
  readSequence: number;
  waiters: Set<() => void>;
  completionObserved: boolean;
  completionPublished: boolean;
};

type BackgroundJobListenerRegistration = {
  ownerInstanceId: string;
  listener: BackgroundJobEventListener;
};

type BackgroundJobManagerOptions = {
  maxRetainedOutputBytes?: number;
  maxOutputReadBytes?: number;
  maxRetainedTerminalJobs?: number;
};

export class BackgroundJobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Set<BackgroundJobListenerRegistration>();
  private readonly closedOwners = new Set<string>();
  private readonly maxRetainedOutputBytes: number;
  private readonly maxOutputReadBytes: number;
  private readonly maxRetainedTerminalJobs: number;
  private closePromise?: Promise<void>;

  constructor(options: BackgroundJobManagerOptions = {}) {
    this.maxRetainedOutputBytes = readPositiveInteger(
      options.maxRetainedOutputBytes,
      DEFAULT_MAX_RETAINED_OUTPUT_BYTES,
      "maxRetainedOutputBytes",
    );
    this.maxOutputReadBytes = readPositiveInteger(
      options.maxOutputReadBytes,
      DEFAULT_MAX_OUTPUT_READ_BYTES,
      "maxOutputReadBytes",
    );
    this.maxRetainedTerminalJobs = readPositiveInteger(
      options.maxRetainedTerminalJobs,
      DEFAULT_MAX_RETAINED_TERMINAL_JOBS,
      "maxRetainedTerminalJobs",
    );
  }

  createOwner(sessionId: string): BackgroundJobOwner {
    const normalized = sessionId.trim();
    if (!normalized) {
      throw new Error("Background Job owner session ID cannot be empty.");
    }
    return Object.freeze({ sessionId: normalized, instanceId: randomUUID() });
  }

  bind(owner: BackgroundJobOwner, options: BindBackgroundJobOwnerOptions): BackgroundJobClient {
    const maxConcurrent = readPositiveInteger(options.maxConcurrent, undefined, "maxConcurrent");
    const logger = options.logger ?? createNoopLogger();
    return Object.freeze({
      owner,
      start: (startOptions) => this.start(owner, maxConcurrent, logger, startOptions),
      list: () => this.list(owner),
      context: () => this.context(owner),
      read: (jobId, readOptions) => this.read(owner, jobId, readOptions),
      peek: (jobId) => this.peek(owner, jobId),
      kill: (jobId, killOptions) => this.kill(owner, jobId, killOptions),
      observe: (jobId) => this.observe(owner, jobId),
      subscribe: (listener) => this.subscribe(owner, listener),
      close: (source = "session_disposal") => this.closeOwner(owner, source),
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const owners = uniqueOwners([...this.jobs.values()].map((job) => job.owner));
    this.closePromise = Promise.all(owners.map((owner) => this.closeOwner(owner, "shutdown"))).then(
      () => {
        this.listeners.clear();
      },
    );
    return this.closePromise;
  }

  private start(
    owner: BackgroundJobOwner,
    maxConcurrent: number,
    logger: Logger,
    options: StartBackgroundJobOptions,
  ): BackgroundJobSummary {
    if (this.closePromise || this.closedOwners.has(owner.instanceId)) {
      logger.warn("background_job.admission_rejected", {
        reason: "owner_closing",
        producer: options.kind,
      });
      throw new Error("Background Jobs are unavailable while the session is closing.");
    }
    const activeCount = [...this.jobs.values()].filter(
      (job) => job.owner.instanceId === owner.instanceId && isActive(job.summary.status),
    ).length;
    if (activeCount >= maxConcurrent) {
      logger.warn("background_job.admission_rejected", {
        reason: "concurrency_limit",
        producer: options.kind,
        activeCount,
        maxConcurrent,
      });
      throw new Error(`Background Job limit reached (${activeCount}/${maxConcurrent}).`);
    }

    const id = `job_${randomUUID()}`;
    const summary: BackgroundJobSummary = {
      id,
      kind: options.kind,
      label: normalizeBackgroundJobLabel(options.label),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      status: "running",
      startedAt: new Date(),
      exitCode: null,
    };
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const record: JobRecord = {
      owner,
      logger,
      summary,
      controller: new AbortController(),
      settlement,
      resolveSettlement,
      chunks: [],
      retainedBytes: 0,
      totalDroppedBytes: 0,
      unreadDroppedBytes: 0,
      nextSequence: 0,
      readSequence: 0,
      waiters: new Set(),
      completionObserved: false,
      completionPublished: false,
    };
    this.jobs.set(id, record);
    logger.info("background_job.started", { jobId: id, producer: options.kind });

    let producer: Promise<BackgroundJobProducerResult>;
    try {
      producer = options.run({
        signal: record.controller.signal,
        write: (stream, text) => this.appendOutput(record, stream, text),
      });
    } catch (error) {
      producer = Promise.reject(error);
    }
    void producer.then(
      (result) => this.finalize(record, result),
      (error) => {
        logger.warn("background_job.producer_failed", {
          jobId: id,
          producer: options.kind,
          errorType: getErrorType(error),
        });
        this.finalize(record, { status: "failed", exitCode: null });
      },
    );

    return cloneSummary(summary);
  }

  private list(owner: BackgroundJobOwner): BackgroundJobSummary[] {
    return [...this.jobs.values()]
      .filter((job) => job.owner.instanceId === owner.instanceId)
      .map((job) => cloneSummary(job.summary))
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  private context(owner: BackgroundJobOwner): BackgroundJobSummary[] {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.owner.instanceId === owner.instanceId &&
          (isActive(job.summary.status) || !job.completionObserved),
      )
      .map((job) => cloneSummary(job.summary))
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  private async read(
    owner: BackgroundJobOwner,
    jobId: string,
    options: ReadBackgroundJobOutputOptions = {},
  ): Promise<BackgroundJobOutputSnapshot> {
    const job = this.findOwnedJob(owner, jobId);
    if (!job) {
      return unknownOutputSnapshot(jobId);
    }
    const waitMs = readNonNegativeInteger(options.waitMs, 0, "waitMs");
    let waitTimedOut = false;
    if (!hasUnreadOutput(job) && isActive(job.summary.status) && waitMs > 0) {
      waitTimedOut = !(await this.waitForChange(job, waitMs, options.signal));
    }
    const snapshot = this.consumeOutput(job, waitTimedOut);
    if (!isActive(snapshot.status)) {
      this.observe(owner, jobId);
    }
    return snapshot;
  }

  private peek(owner: BackgroundJobOwner, jobId: string): BackgroundJobPeekSnapshot {
    const job = this.findOwnedJob(owner, jobId);
    if (!job) {
      return {
        jobId,
        status: "unknown",
        chunks: [],
        truncated: false,
        droppedBytes: 0,
        exitCode: null,
      };
    }
    const chunks: BackgroundJobOutputChunk[] = [];
    let includedBytes = 0;
    for (let index = job.chunks.length - 1; index >= 0; index -= 1) {
      const chunk = job.chunks[index];
      if (
        !chunk ||
        (chunks.length > 0 && includedBytes + chunk.byteLength > this.maxOutputReadBytes)
      ) {
        break;
      }
      chunks.unshift({ stream: chunk.stream, text: chunk.text });
      includedBytes += chunk.byteLength;
    }
    return {
      jobId,
      status: job.summary.status,
      chunks,
      truncated:
        job.totalDroppedBytes > 0 ||
        includedBytes < job.chunks.reduce((sum, item) => sum + item.byteLength, 0),
      droppedBytes: job.totalDroppedBytes,
      exitCode: job.summary.exitCode,
    };
  }

  private async kill(
    owner: BackgroundJobOwner,
    jobId: string,
    options: KillBackgroundJobOptions,
  ): Promise<BackgroundJobSummary> {
    const job = this.findOwnedJob(owner, jobId);
    if (!job) {
      return unknownSummary(jobId);
    }
    if (!isActive(job.summary.status)) {
      if (shouldObserveCompletion(options.source)) {
        this.observe(owner, jobId);
      }
      return cloneSummary(job.summary);
    }
    if (job.summary.status === "running") {
      job.summary.status = "stopping";
      job.logger.info("background_job.cancellation_requested", {
        jobId,
        producer: job.summary.kind,
        source: options.source,
      });
      job.controller.abort(options.reason ?? "Background Job cancellation requested.");
      this.wakeWaiters(job);
    }
    await job.settlement;
    if (shouldObserveCompletion(options.source)) {
      this.observe(owner, jobId);
    }
    return cloneSummary(job.summary);
  }

  private observe(owner: BackgroundJobOwner, jobId: string): void {
    const job = this.findOwnedJob(owner, jobId);
    if (!job || isActive(job.summary.status) || job.completionObserved) {
      return;
    }
    job.completionObserved = true;
    this.emit({ type: "observed", owner, job: cloneSummary(job.summary) });
    this.pruneTerminalJobs(owner);
  }

  private subscribe(owner: BackgroundJobOwner, listener: BackgroundJobEventListener): () => void {
    const registration = { ownerInstanceId: owner.instanceId, listener };
    this.listeners.add(registration);
    return () => {
      this.listeners.delete(registration);
    };
  }

  private async closeOwner(
    owner: BackgroundJobOwner,
    source: "session_disposal" | "shutdown",
  ): Promise<void> {
    this.closedOwners.add(owner.instanceId);
    const owned = [...this.jobs.values()].filter(
      (job) => job.owner.instanceId === owner.instanceId,
    );
    await Promise.all(
      owned.map((job) =>
        this.kill(owner, job.summary.id, { source }).catch((error) => {
          job.logger.warn("background_job.cleanup_failed", {
            jobId: job.summary.id,
            producer: job.summary.kind,
            phase: source,
            errorType: getErrorType(error),
          });
        }),
      ),
    );
    for (const job of owned) {
      this.jobs.delete(job.summary.id);
    }
    for (const registration of this.listeners) {
      if (registration.ownerInstanceId === owner.instanceId) {
        this.listeners.delete(registration);
      }
    }
  }

  private appendOutput(job: JobRecord, stream: BackgroundJobOutputStream, text: string): void {
    if (!text || !isActive(job.summary.status)) {
      return;
    }
    for (const piece of splitByUtf8Bytes(text, Math.min(4096, this.maxOutputReadBytes))) {
      const chunk: OutputChunk = {
        sequence: job.nextSequence,
        stream,
        text: piece,
        byteLength: Buffer.byteLength(piece),
      };
      job.nextSequence += 1;
      job.chunks.push(chunk);
      job.retainedBytes += chunk.byteLength;
    }
    while (job.retainedBytes > this.maxRetainedOutputBytes && job.chunks.length > 0) {
      const removed = job.chunks.shift();
      if (!removed) {
        break;
      }
      job.retainedBytes -= removed.byteLength;
      job.totalDroppedBytes += removed.byteLength;
      if (removed.sequence >= job.readSequence) {
        job.unreadDroppedBytes += removed.byteLength;
        job.readSequence = removed.sequence + 1;
      }
    }
    this.wakeWaiters(job);
  }

  private consumeOutput(job: JobRecord, waitTimedOut: boolean): BackgroundJobOutputSnapshot {
    const chunks: BackgroundJobOutputChunk[] = [];
    let bytes = 0;
    for (const chunk of job.chunks) {
      if (chunk.sequence < job.readSequence) {
        continue;
      }
      if (chunks.length > 0 && bytes + chunk.byteLength > this.maxOutputReadBytes) {
        break;
      }
      chunks.push({ stream: chunk.stream, text: chunk.text });
      bytes += chunk.byteLength;
      job.readSequence = chunk.sequence + 1;
    }
    const droppedBytes = job.unreadDroppedBytes;
    job.unreadDroppedBytes = 0;
    return {
      jobId: job.summary.id,
      status: job.summary.status,
      chunks,
      hasMore: job.chunks.some((chunk) => chunk.sequence >= job.readSequence),
      droppedBytes,
      waitTimedOut,
      exitCode: job.summary.exitCode,
    };
  }

  private waitForChange(job: JobRecord, waitMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Background Job output wait aborted."));
    }
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (changed: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        job.waiters.delete(onChanged);
        resolve(changed);
      };
      const onChanged = (): void => finish(true);
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        job.waiters.delete(onChanged);
        reject(signal?.reason ?? new Error("Background Job output wait aborted."));
      };
      const timer = setTimeout(() => finish(false), waitMs);
      job.waiters.add(onChanged);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (hasUnreadOutput(job) || !isActive(job.summary.status)) {
        finish(true);
      }
    });
  }

  private finalize(job: JobRecord, result: BackgroundJobProducerResult): void {
    if (!isActive(job.summary.status)) {
      return;
    }
    job.summary.status = result.status;
    job.summary.exitCode = result.exitCode;
    job.summary.finishedAt = new Date();
    job.resolveSettlement();
    this.wakeWaiters(job);
    const level = result.status === "completed" || result.status === "canceled" ? "info" : "warn";
    job.logger[level]("background_job.process_exited", {
      jobId: job.summary.id,
      producer: job.summary.kind,
      outcome: result.status,
      exitCode: result.exitCode,
    });
    queueMicrotask(() => {
      if (job.completionObserved || job.completionPublished) {
        return;
      }
      job.completionPublished = true;
      this.emit({ type: "completed", owner: job.owner, job: cloneSummary(job.summary) });
      this.pruneTerminalJobs(job.owner);
    });
  }

  private pruneTerminalJobs(owner: BackgroundJobOwner): void {
    const terminal = [...this.jobs.values()]
      .filter((job) => job.owner.instanceId === owner.instanceId && !isActive(job.summary.status))
      .sort(
        (left, right) =>
          (left.summary.finishedAt?.getTime() ?? 0) - (right.summary.finishedAt?.getTime() ?? 0),
      );
    for (const job of terminal.slice(0, -this.maxRetainedTerminalJobs)) {
      if (!job.completionObserved) {
        job.completionObserved = true;
        this.emit({ type: "observed", owner: job.owner, job: cloneSummary(job.summary) });
      }
      this.jobs.delete(job.summary.id);
    }
  }

  private findOwnedJob(owner: BackgroundJobOwner, jobId: string): JobRecord | undefined {
    const job = this.jobs.get(jobId);
    return job?.owner.instanceId === owner.instanceId ? job : undefined;
  }

  private wakeWaiters(job: JobRecord): void {
    for (const waiter of [...job.waiters]) {
      waiter();
    }
  }

  private emit(event: BackgroundJobCompletionEvent): void {
    for (const registration of [...this.listeners]) {
      if (registration.ownerInstanceId !== event.owner.instanceId) {
        continue;
      }
      try {
        registration.listener({
          ...event,
          owner: event.owner,
          job: cloneSummary(event.job),
        });
      } catch (error) {
        const job = this.jobs.get(event.job.id);
        job?.logger.warn("background_job.listener_failed", {
          eventType: event.type,
          errorType: getErrorType(error),
        });
      }
    }
  }
}

function normalizeBackgroundJobLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || "Background Job";
  if (Buffer.byteLength(normalized) <= MAX_BACKGROUND_JOB_LABEL_BYTES) {
    return normalized;
  }

  const marker = "…";
  const maxContentBytes = MAX_BACKGROUND_JOB_LABEL_BYTES - Buffer.byteLength(marker);
  let content = "";
  let contentBytes = 0;
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character);
    if (contentBytes + characterBytes > maxContentBytes) {
      break;
    }
    content += character;
    contentBytes += characterBytes;
  }
  return `${content.trimEnd()}${marker}`;
}

function hasUnreadOutput(job: JobRecord): boolean {
  return (
    job.unreadDroppedBytes > 0 || job.chunks.some((chunk) => chunk.sequence >= job.readSequence)
  );
}

function isActive(status: BackgroundJobStatus): status is "running" | "stopping" {
  return status === "running" || status === "stopping";
}

function shouldObserveCompletion(source: KillBackgroundJobOptions["source"]): boolean {
  return source === "tool";
}

function cloneSummary(summary: BackgroundJobSummary): BackgroundJobSummary {
  return structuredClone(summary);
}

function unknownSummary(jobId: string): BackgroundJobSummary {
  return {
    id: jobId,
    kind: "unknown",
    label: "Unknown Background Job",
    status: "unknown",
    startedAt: new Date(0),
    finishedAt: new Date(0),
    exitCode: null,
  };
}

function unknownOutputSnapshot(jobId: string): BackgroundJobOutputSnapshot {
  return {
    jobId,
    status: "unknown",
    chunks: [],
    hasMore: false,
    droppedBytes: 0,
    waitTimedOut: false,
    exitCode: null,
  };
}

function uniqueOwners(owners: BackgroundJobOwner[]): BackgroundJobOwner[] {
  return [...new Map(owners.map((owner) => [owner.instanceId, owner])).values()];
}

function splitByUtf8Bytes(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number | undefined,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (resolved === undefined || !Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
}

function readNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function getErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
