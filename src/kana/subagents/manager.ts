import { randomUUID } from "node:crypto";

import type { AgentEndReason } from "@/agent";
import type { Message } from "@/core";
import { type OwnedTask, type OwnedTaskEvent, OwnedTaskRegistry } from "@/jobs";
import { createNoopLogger, type Logger } from "@/logging";
import { formatError } from "@/utils";
import type { KanaSubagentProfile } from "./profiles";

const DEFAULT_MAX_RETAINED_TERMINAL_SUBAGENTS = 32;
const MAX_LABEL_LENGTH = 160;

type KanaSubagentStatus = "running" | "completed" | "errored" | "canceled" | "unknown";

export type KanaSubagentOwner = Readonly<{
  readonly sessionId: string;
  readonly instanceId: string;
  readonly cwd: string;
  readonly persistent: boolean;
}>;

export type KanaSubagentSummary = {
  readonly id: string;
  readonly profile: string;
  readonly label: string;
  readonly status: KanaSubagentStatus;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly model?: { provider: string; model: string };
  readonly terminalReason?: AgentEndReason;
};

export type KanaSubagentSnapshot = KanaSubagentSummary & {
  readonly output: string;
  readonly error?: string;
  readonly waitTimedOut: boolean;
};

export type KanaSubagentInspection = KanaSubagentSnapshot & {
  readonly task: string;
  readonly messages: readonly Message[];
};

export type KanaSubagentRunResult = {
  readonly status: Exclude<KanaSubagentStatus, "running" | "unknown">;
  readonly output: string;
  readonly messages: readonly Message[];
  readonly model?: { provider: string; model: string };
  readonly terminalReason?: AgentEndReason;
  readonly error?: string;
};

export type KanaSubagentRunContext = {
  readonly agentId: string;
  readonly signal: AbortSignal;
  readonly profile: KanaSubagentProfile;
  readonly task: string;
  readonly spawnToolCallId: string;
  readonly owner: KanaSubagentOwner;
  setLiveSnapshot(read: () => Pick<KanaSubagentRunResult, "messages" | "model">): void;
};

type StartKanaSubagentOptions = {
  readonly profile: KanaSubagentProfile;
  readonly task: string;
  readonly spawnToolCallId: string;
  run(context: KanaSubagentRunContext): Promise<KanaSubagentRunResult>;
};

type WaitKanaSubagentOptions = {
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
};

type CancelKanaSubagentOptions = {
  readonly reason?: string;
  readonly source: "tool" | "tui" | "session_disposal" | "shutdown";
};

export type KanaSubagentEvent = OwnedTaskEvent<KanaSubagentOwner, KanaSubagentSummary>;

export type KanaSubagentClient = {
  readonly owner: KanaSubagentOwner;
  start(options: StartKanaSubagentOptions): KanaSubagentSummary;
  list(): KanaSubagentSummary[];
  context(): KanaSubagentSummary[];
  wait(agentId: string, options?: WaitKanaSubagentOptions): Promise<KanaSubagentSnapshot>;
  inspect(agentId: string): KanaSubagentInspection | undefined;
  cancel(agentId: string, options: CancelKanaSubagentOptions): Promise<KanaSubagentSummary>;
  observe(agentId: string): void;
  subscribe(listener: (event: KanaSubagentEvent) => void): () => void;
  close(source?: "session_disposal" | "shutdown"): Promise<void>;
};

type SubagentState = {
  readonly profile: KanaSubagentProfile;
  readonly task: string;
  output: string;
  messages: readonly Message[];
  readLiveSnapshot?: () => Pick<KanaSubagentRunResult, "messages" | "model">;
  error?: string;
};

type Subagent = OwnedTask<KanaSubagentOwner, KanaSubagentSummary, SubagentState>;

export type KanaSubagentManagerOptions = {
  readonly maxRetainedTerminalSubagents?: number;
};

export class KanaSubagentManager {
  private readonly registry: OwnedTaskRegistry<
    KanaSubagentOwner,
    KanaSubagentSummary,
    SubagentState
  >;

  constructor(options: KanaSubagentManagerOptions = {}) {
    this.registry = new OwnedTaskRegistry({
      logPrefix: "subagent",
      displayName: "Subagent",
      maxRetainedTerminal:
        options.maxRetainedTerminalSubagents ?? DEFAULT_MAX_RETAINED_TERMINAL_SUBAGENTS,
      isActive: (summary) => summary.status === "running",
    });
  }

  createOwner(options: { sessionId: string; cwd: string; persistent: boolean }): KanaSubagentOwner {
    return Object.freeze({ ...options, instanceId: randomUUID() });
  }

  bind(
    owner: KanaSubagentOwner,
    options: { maxLive: number; logger?: Logger },
  ): KanaSubagentClient {
    const logger = options.logger ?? createNoopLogger();
    return Object.freeze({
      owner,
      start: (startOptions) => this.start(owner, options.maxLive, logger, startOptions),
      list: () => this.registry.list(owner),
      context: () => this.registry.context(owner),
      wait: (agentId, waitOptions) => this.wait(owner, agentId, waitOptions),
      inspect: (agentId) => this.inspect(owner, agentId),
      cancel: (agentId, cancelOptions) => this.cancel(owner, agentId, cancelOptions),
      observe: (agentId) => this.registry.observe(owner, agentId),
      subscribe: (listener) => this.registry.subscribe(owner, listener),
      close: (source = "session_disposal") =>
        this.registry.closeOwner(owner, source, (subagent) => this.stop(subagent, { source })),
    });
  }

  close(): Promise<void> {
    return this.registry.close((subagent) => this.stop(subagent, { source: "shutdown" }));
  }

  private start(
    owner: KanaSubagentOwner,
    maxLive: number,
    logger: Logger,
    options: StartKanaSubagentOptions,
  ): KanaSubagentSummary {
    this.registry.admit(owner, maxLive, logger, { profile: options.profile.name });

    const summary: KanaSubagentSummary = {
      id: `agent_${randomUUID()}`,
      profile: options.profile.name,
      label: createLabel(options.profile.name, options.task),
      status: "running",
      startedAt: new Date(),
    };
    const subagent = this.registry.add(
      owner,
      summary,
      { profile: options.profile, task: options.task, output: "", messages: [] },
      logger,
    );
    logger.info("subagent.started", { agentId: summary.id, profile: options.profile.name });

    void Promise.resolve()
      .then(() =>
        options.run({
          agentId: summary.id,
          signal: subagent.controller.signal,
          profile: options.profile,
          task: options.task,
          spawnToolCallId: options.spawnToolCallId,
          owner,
          setLiveSnapshot: (read) => {
            subagent.state.readLiveSnapshot = read;
          },
        }),
      )
      .then(
        (result) => this.finalize(subagent, result),
        (error) =>
          this.finalize(subagent, {
            status: "errored",
            output: "",
            messages: [],
            error: formatError(error),
          }),
      );
    return summary;
  }

  private async wait(
    owner: KanaSubagentOwner,
    agentId: string,
    options: WaitKanaSubagentOptions = {},
  ): Promise<KanaSubagentSnapshot> {
    const subagent = this.registry.find(owner, agentId);
    if (!subagent) return unknownSnapshot(agentId);
    const waitMs = options.waitMs ?? 0;
    const settled = () => subagent.summary.status !== "running";
    const waitTimedOut =
      waitMs > 0 && !(await this.registry.waitUntil(subagent, settled, waitMs, options.signal));
    const snapshot = snapshotOf(subagent, waitTimedOut);
    if (snapshot.status !== "running") this.registry.observe(owner, agentId);
    return snapshot;
  }

  private inspect(owner: KanaSubagentOwner, agentId: string): KanaSubagentInspection | undefined {
    const subagent = this.registry.find(owner, agentId);
    if (!subagent) return undefined;
    const live =
      subagent.summary.status === "running" ? subagent.state.readLiveSnapshot?.() : undefined;
    return {
      ...snapshotOf(subagent, false),
      ...(live?.model ? { model: live.model } : {}),
      task: subagent.state.task,
      messages: live?.messages ?? subagent.state.messages,
    };
  }

  private async cancel(
    owner: KanaSubagentOwner,
    agentId: string,
    options: CancelKanaSubagentOptions,
  ): Promise<KanaSubagentSummary> {
    const subagent = this.registry.find(owner, agentId);
    if (!subagent) return unknownSummary(agentId);
    await this.stop(subagent, options);
    // Only the model's own cancel counts as having seen the completion.
    if (options.source === "tool") this.registry.observe(owner, agentId);
    return subagent.summary;
  }

  private async stop(subagent: Subagent, options: CancelKanaSubagentOptions): Promise<void> {
    if (subagent.summary.status === "running") {
      subagent.logger.info("subagent.cancellation_requested", {
        agentId: subagent.summary.id,
        profile: subagent.state.profile.name,
        source: options.source,
      });
      subagent.controller.abort(options.reason ?? "Subagent cancellation requested.");
    }
    await subagent.settled;
  }

  private finalize(subagent: Subagent, result: KanaSubagentRunResult): void {
    if (subagent.summary.status !== "running") return;
    const status = subagent.controller.signal.aborted ? "canceled" : result.status;
    subagent.state = {
      ...subagent.state,
      output: result.output,
      messages: result.messages,
      readLiveSnapshot: undefined,
      error: result.error,
    };
    this.registry.settle(subagent, {
      ...subagent.summary,
      status,
      finishedAt: new Date(),
      model: result.model,
      terminalReason: result.terminalReason,
    });
    subagent.logger[status === "errored" ? "warn" : "info"]("subagent.settled", {
      agentId: subagent.summary.id,
      profile: subagent.state.profile.name,
      status,
      terminalReason: result.terminalReason,
    });
  }
}

function snapshotOf(subagent: Subagent, waitTimedOut: boolean): KanaSubagentSnapshot {
  return {
    ...subagent.summary,
    output: subagent.state.output,
    ...(subagent.state.error === undefined ? {} : { error: subagent.state.error }),
    waitTimedOut,
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
