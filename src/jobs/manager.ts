import { randomUUID } from "node:crypto";

import { createNoopLogger, type Logger } from "@/logging";
import { errorFields } from "@/utils";
import { type OwnedTask, type OwnedTaskEvent, OwnedTaskRegistry } from "./owned-tasks";

const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_PEEK_BYTES = 20 * 1024;
const MAX_OUTPUT_CHUNK_BYTES = 4096;
const DEFAULT_MAX_RETAINED_TERMINAL_JOBS = 32;
const MAX_BACKGROUND_JOB_LABEL_BYTES = 512;

export type BackgroundJobStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type BackgroundJobTerminalStatus = Exclude<BackgroundJobStatus, "running" | "stopping">;

export type BackgroundJobOutputStream = "stdout" | "stderr";

type BackgroundJobOwner = Readonly<{
  readonly sessionId: string;
  readonly instanceId: string;
}>;

export type BackgroundJobSummary = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly cwd?: string;
  readonly status: BackgroundJobStatus;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly exitCode: number | null;
};

export type BackgroundJobOutputChunk = {
  readonly stream: BackgroundJobOutputStream;
  readonly text: string;
};

export type BackgroundJobOutputSnapshot = {
  readonly jobId: string;
  readonly status: BackgroundJobStatus;
  readonly chunks: readonly BackgroundJobOutputChunk[];
  readonly droppedBytes: number;
  readonly waitTimedOut: boolean;
  readonly exitCode: number | null;
};

export type BackgroundJobPeekSnapshot = {
  readonly jobId: string;
  readonly status: BackgroundJobStatus;
  readonly chunks: readonly BackgroundJobOutputChunk[];
  readonly truncated: boolean;
  readonly droppedBytes: number;
  readonly exitCode: number | null;
};

type BackgroundJobProducerResult = {
  readonly status: BackgroundJobTerminalStatus;
  readonly exitCode: number | null;
};

type BackgroundJobEvent = OwnedTaskEvent<BackgroundJobOwner, BackgroundJobSummary>;

type BackgroundJobEventListener = (event: BackgroundJobEvent) => void;

type BackgroundJobProducerContext = {
  readonly signal: AbortSignal;
  write(stream: BackgroundJobOutputStream, text: string): void;
};

type StartBackgroundJobOptions = {
  readonly kind: string;
  readonly label: string;
  readonly cwd?: string;
  run(context: BackgroundJobProducerContext): Promise<BackgroundJobProducerResult>;
};

type ReadBackgroundJobOutputOptions = {
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
};

type KillBackgroundJobOptions = {
  readonly reason?: string;
  readonly source: "tool" | "tui" | "session_disposal" | "shutdown";
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
  readonly maxConcurrent: number;
  readonly logger?: Logger;
};

type OutputChunk = BackgroundJobOutputChunk & {
  sequence: number;
  byteLength: number;
};

type JobOutput = {
  chunks: OutputChunk[];
  retainedBytes: number;
  totalDroppedBytes: number;
  unreadDroppedBytes: number;
  nextSequence: number;
  readSequence: number;
};

type Job = OwnedTask<BackgroundJobOwner, BackgroundJobSummary, JobOutput>;

type BackgroundJobManagerOptions = {
  readonly maxRetainedOutputBytes?: number;
  readonly maxRetainedTerminalJobs?: number;
};

export class BackgroundJobManager {
  private readonly registry: OwnedTaskRegistry<BackgroundJobOwner, BackgroundJobSummary, JobOutput>;
  private readonly maxRetainedOutputBytes: number;

  constructor(options: BackgroundJobManagerOptions = {}) {
    this.maxRetainedOutputBytes =
      options.maxRetainedOutputBytes ?? DEFAULT_MAX_RETAINED_OUTPUT_BYTES;
    this.registry = new OwnedTaskRegistry({
      logPrefix: "background_job",
      displayName: "Background Job",
      maxRetainedTerminal: options.maxRetainedTerminalJobs ?? DEFAULT_MAX_RETAINED_TERMINAL_JOBS,
      isActive: (summary) => isActive(summary.status),
    });
  }

  createOwner(sessionId: string): BackgroundJobOwner {
    return Object.freeze({ sessionId, instanceId: randomUUID() });
  }

  bind(owner: BackgroundJobOwner, options: BindBackgroundJobOwnerOptions): BackgroundJobClient {
    const logger = options.logger ?? createNoopLogger();
    return Object.freeze({
      owner,
      start: (startOptions) => this.start(owner, options.maxConcurrent, logger, startOptions),
      list: () => this.registry.list(owner),
      context: () => this.registry.context(owner),
      read: (jobId, readOptions) => this.read(owner, jobId, readOptions),
      peek: (jobId) => this.peek(owner, jobId),
      kill: (jobId, killOptions) => this.kill(owner, jobId, killOptions),
      observe: (jobId) => this.registry.observe(owner, jobId),
      subscribe: (listener) => this.registry.subscribe(owner, listener),
      close: (source = "session_disposal") =>
        this.registry.closeOwner(owner, source, (job) => this.stop(job, { source })),
    });
  }

  close(): Promise<void> {
    return this.registry.close((job) => this.stop(job, { source: "shutdown" }));
  }

  private start(
    owner: BackgroundJobOwner,
    maxConcurrent: number,
    logger: Logger,
    options: StartBackgroundJobOptions,
  ): BackgroundJobSummary {
    this.registry.admit(owner, maxConcurrent, logger, { producer: options.kind });

    const summary: BackgroundJobSummary = {
      id: `job_${randomUUID()}`,
      kind: options.kind,
      label: normalizeBackgroundJobLabel(options.label),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      status: "running",
      startedAt: new Date(),
      exitCode: null,
    };
    const job = this.registry.add(
      owner,
      summary,
      {
        chunks: [],
        retainedBytes: 0,
        totalDroppedBytes: 0,
        unreadDroppedBytes: 0,
        nextSequence: 0,
        readSequence: 0,
      },
      logger,
    );
    logger.info("background_job.started", { jobId: summary.id, producer: options.kind });

    let producer: Promise<BackgroundJobProducerResult>;
    try {
      producer = options.run({
        signal: job.controller.signal,
        write: (stream, text) => this.appendOutput(job, stream, text),
      });
    } catch (error) {
      producer = Promise.reject(error);
    }
    producer.then(
      (result) => this.finalize(job, result),
      (error) => {
        logger.warn("background_job.producer_failed", {
          jobId: summary.id,
          producer: options.kind,
          ...errorFields(error),
        });
        this.finalize(job, { status: "failed", exitCode: null });
      },
    );

    return summary;
  }

  private async read(
    owner: BackgroundJobOwner,
    jobId: string,
    options: ReadBackgroundJobOutputOptions = {},
  ): Promise<BackgroundJobOutputSnapshot> {
    const job = this.registry.find(owner, jobId);
    if (!job) {
      return unknownOutputSnapshot(jobId);
    }
    const waitMs = options.waitMs ?? 0;
    const ready = () => hasUnreadOutput(job.state) || !isActive(job.summary.status);
    const waitTimedOut =
      waitMs > 0 && !(await this.registry.waitUntil(job, ready, waitMs, options.signal));
    const snapshot = consumeOutput(job, waitTimedOut);
    if (!isActive(snapshot.status)) {
      this.registry.observe(owner, jobId);
    }
    return snapshot;
  }

  private peek(owner: BackgroundJobOwner, jobId: string): BackgroundJobPeekSnapshot {
    const job = this.registry.find(owner, jobId);
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
    const { chunks: retained, totalDroppedBytes } = job.state;
    const chunks: BackgroundJobOutputChunk[] = [];
    let includedBytes = 0;
    for (const chunk of [...retained].reverse()) {
      if (chunks.length > 0 && includedBytes + chunk.byteLength > MAX_OUTPUT_PEEK_BYTES) {
        break;
      }
      chunks.unshift({ stream: chunk.stream, text: chunk.text });
      includedBytes += chunk.byteLength;
    }
    return {
      jobId,
      status: job.summary.status,
      chunks,
      truncated: totalDroppedBytes > 0 || chunks.length < retained.length,
      droppedBytes: totalDroppedBytes,
      exitCode: job.summary.exitCode,
    };
  }

  private async kill(
    owner: BackgroundJobOwner,
    jobId: string,
    options: KillBackgroundJobOptions,
  ): Promise<BackgroundJobSummary> {
    const job = this.registry.find(owner, jobId);
    if (!job) {
      return unknownSummary(jobId);
    }
    await this.stop(job, options);
    // Only the model's own kill counts as having seen the completion; a TUI
    // kill still reports the outcome to the model.
    if (options.source === "tool") {
      this.registry.observe(owner, jobId);
    }
    return job.summary;
  }

  private async stop(job: Job, options: KillBackgroundJobOptions): Promise<void> {
    if (job.summary.status === "running") {
      job.summary = { ...job.summary, status: "stopping" };
      job.logger.info("background_job.cancellation_requested", {
        jobId: job.summary.id,
        producer: job.summary.kind,
        source: options.source,
      });
      job.controller.abort(options.reason ?? "Background Job cancellation requested.");
      this.registry.publishStopping(job);
    }
    await job.settled;
  }

  private appendOutput(job: Job, stream: BackgroundJobOutputStream, text: string): void {
    if (!text || !isActive(job.summary.status)) {
      return;
    }
    const output = job.state;
    for (const piece of splitByUtf8Bytes(text, MAX_OUTPUT_CHUNK_BYTES)) {
      const byteLength = Buffer.byteLength(piece);
      output.chunks.push({ sequence: output.nextSequence, stream, text: piece, byteLength });
      output.nextSequence += 1;
      output.retainedBytes += byteLength;
    }
    while (output.retainedBytes > this.maxRetainedOutputBytes) {
      const removed = output.chunks.shift();
      if (!removed) break;
      output.retainedBytes -= removed.byteLength;
      output.totalDroppedBytes += removed.byteLength;
      if (removed.sequence >= output.readSequence) {
        output.unreadDroppedBytes += removed.byteLength;
        output.readSequence = removed.sequence + 1;
      }
    }
    this.registry.notify(job);
  }

  private finalize(job: Job, result: BackgroundJobProducerResult): void {
    if (!isActive(job.summary.status)) {
      return;
    }
    this.registry.settle(job, {
      ...job.summary,
      status: result.status,
      exitCode: result.exitCode,
      finishedAt: new Date(),
    });
    const level = result.status === "completed" || result.status === "cancelled" ? "info" : "warn";
    job.logger[level]("background_job.process_exited", {
      jobId: job.summary.id,
      producer: job.summary.kind,
      outcome: result.status,
      exitCode: result.exitCode,
    });
  }
}

function consumeOutput(job: Job, waitTimedOut: boolean): BackgroundJobOutputSnapshot {
  const output = job.state;
  const chunks = output.chunks
    .filter((chunk) => chunk.sequence >= output.readSequence)
    .map(({ stream, text }) => ({ stream, text }));
  output.readSequence = output.nextSequence;
  const droppedBytes = output.unreadDroppedBytes;
  output.unreadDroppedBytes = 0;
  return {
    jobId: job.summary.id,
    status: job.summary.status,
    chunks,
    droppedBytes,
    waitTimedOut,
    exitCode: job.summary.exitCode,
  };
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

function isActive(status: BackgroundJobStatus): status is "running" | "stopping" {
  return status === "running" || status === "stopping";
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
    droppedBytes: 0,
    waitTimedOut: false,
    exitCode: null,
  };
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

function hasUnreadOutput(output: JobOutput): boolean {
  return (
    output.unreadDroppedBytes > 0 ||
    output.chunks.some((chunk) => chunk.sequence >= output.readSequence)
  );
}
