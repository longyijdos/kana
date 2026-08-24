import type { AgentEndReason, BeforeToolExecutionHook } from "@/agent";
import { type AssistantMessage, addModelUsage, createUserMessage, type ModelUsage } from "@/core";
import {
  ConversationRuntime,
  type ConversationRuntimeEvent,
  createKanaConversationHost,
  type KanaLaunchMode,
  type KanaToolApprovalConfig,
  type KanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";
import type { Logger } from "@/logging";
import type { McpServerDiagnostic } from "@/mcp";
import {
  createKanaExecEvent,
  type KanaExecEvent,
  type KanaExecRunTermination,
  toKanaExecUsage,
} from "./protocol";
import { assertValidHeadlessTimeoutMs } from "./timeout";

export type StartHeadlessOptions = {
  prompt?: string;
  resumeSessionId?: string;
  launchMode?: KanaLaunchMode;
  json?: boolean;
  allowAllTools?: boolean;
  timeoutMs?: number;
};

export type HeadlessOutputStream = {
  write(chunk: string): unknown;
};

export type RunHeadlessConversationOptions = {
  runtime: ConversationRuntime;
  prompt: string;
  approvalConfig: KanaToolApprovalConfig;
  toolApprovals: KanaToolApprovals;
  allowAllTools?: boolean;
  json?: boolean;
  warnings?: readonly HeadlessWarning[];
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: Logger;
  stdout?: HeadlessOutputStream;
  stderr?: HeadlessOutputStream;
};

type HeadlessRunTermination =
  | {
      reason: "timeout";
      timeoutMs: number;
    }
  | {
      reason: "sigint";
    };

export type HeadlessRunResult = {
  exitCode: number;
  outcome?: AgentEndReason;
  termination?: HeadlessRunTermination;
  finalMessage?: string;
  usage?: ModelUsage;
};

type HeadlessWarning = {
  phase: "mcp_startup";
  message: string;
  serverId?: string;
};

const HEADLESS_SIGNAL_REASON = Symbol("headlessSignalReason");

type HeadlessSignalReason = {
  [HEADLESS_SIGNAL_REASON]: HeadlessRunTermination;
};

export async function startHeadless(options: StartHeadlessOptions = {}): Promise<number> {
  try {
    assertValidHeadlessTimeoutMs(options.timeoutMs);
  } catch (error) {
    writeStartupError(error, options.json ?? false);
    return 1;
  }

  if (options.launchMode === "clean" && options.resumeSessionId !== undefined) {
    writeStartupError(
      new Error("Clean mode cannot resume saved sessions because its session is temporary."),
      options.json ?? false,
    );
    return 1;
  }

  let prompt: string;
  try {
    prompt = await resolveHeadlessPrompt(options.prompt);
  } catch (error) {
    writeStartupError(error, options.json ?? false);
    return 1;
  }

  const controller = new AbortController();
  let runtime: ConversationRuntime | undefined;
  const onInterrupt = (): void => {
    if (controller.signal.aborted) {
      return;
    }
    // Brand only frontend-owned cancellation so arbitrary callers using the
    // public AbortSignal path remain ordinary `aborted` runs.
    controller.abort(createHeadlessSignalReason({ reason: "sigint" }));
  };
  process.once("SIGINT", onInterrupt);

  let host: ReturnType<typeof createKanaConversationHost> | undefined;
  try {
    host = createKanaConversationHost({
      session: options.resumeSessionId
        ? { type: "resume", sessionId: options.resumeSessionId }
        : { type: "new" },
      // A one-shot process cannot honor a future process-local wake after it
      // exits, so do not advertise schedule_wake in the headless tool set.
      enableScheduledWakeTool: false,
      launchMode: options.launchMode,
    });
    runtime = createHeadlessRuntime(host);
    host.getLogger().info("headless.started", {
      launchMode: options.launchMode ?? "normal",
      outputMode: options.json ? "jsonl" : "human",
      resumed: options.resumeSessionId !== undefined,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

    const mcpSnapshot = await host.startMcp();
    runtime.reconfigure();
    host.getLogger().info("headless.mcp_ready", {
      selectedServerCount: mcpSnapshot.selectedServerIds.length,
      readyServerCount: mcpSnapshot.diagnostics.filter(
        (diagnostic) => diagnostic.status === "ready",
      ).length,
      toolCount: mcpSnapshot.tools.length,
    });
    if (controller.signal.aborted) {
      host.getLogger().info("headless.interrupted", { phase: "mcp_startup" });
      return 130;
    }

    const result = await runHeadlessConversation({
      runtime,
      prompt,
      approvalConfig: host.approvalConfig,
      toolApprovals: host.toolApprovals,
      allowAllTools: options.allowAllTools,
      json: options.json,
      warnings: warningsFromMcpDiagnostics(mcpSnapshot.diagnostics),
      signal: controller.signal,
      timeoutMs: options.timeoutMs,
      logger: host.getLogger(),
    });
    const exitCode = result.exitCode;
    host.getLogger().info("headless.completed", {
      outcome: result.outcome ?? "failed",
      exitCode,
      ...(result.termination === undefined ? {} : { terminationReason: result.termination.reason }),
    });
    return exitCode;
  } catch (error) {
    host?.getLogger().error("headless.failed", {
      phase: runtime === undefined ? "initialization" : "mcp_startup",
      error,
    });
    writeStartupError(error, options.json ?? false);
    return readHeadlessSignalReason(controller.signal)?.reason === "sigint" ? 130 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    try {
      await runtime?.close();
    } finally {
      await host?.close();
    }
  }
}

export async function runHeadlessConversation(
  options: RunHeadlessConversationOptions,
): Promise<HeadlessRunResult> {
  assertValidHeadlessTimeoutMs(options.timeoutMs);
  let abortRequested = false;
  let termination: HeadlessRunTermination | undefined;
  const requestAbort = (requestedTermination?: HeadlessRunTermination): boolean => {
    // Preserve the first cancellation source when timeout and SIGINT arrive
    // together so output and exit status cannot disagree.
    if (abortRequested) {
      return false;
    }
    abortRequested = true;
    termination = requestedTermination;
    options.runtime.abort();
    return true;
  };
  const output = new HeadlessRunOutput({
    json: options.json ?? false,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    getTermination: () => termination,
  });
  output.startSession(options.runtime.sessionId);
  for (const warning of options.warnings ?? []) {
    output.warning(warning);
  }

  const beforeToolExecution = createHeadlessApprovalHook(options, output);
  options.runtime.setBeforeToolExecution(beforeToolExecution);
  const onAbort = (): void => {
    requestAbort(readHeadlessSignalReason(options.signal));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const unsubscribe = options.runtime.subscribe((event) => {
    output.handle(event);
  });

  try {
    const timeoutMs = options.timeoutMs;
    // This is an Agent-run deadline: session/MCP startup happened before this
    // boundary, and normal frontend cleanup continues after the timer is cleared.
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (requestAbort({ reason: "timeout", timeoutMs })) {
              options.logger?.warn("headless.timeout_elapsed", {
                phase: "run",
                timeoutMs,
              });
            }
          }, timeoutMs);
    try {
      const submission = options.runtime.submit(
        createUserMessage({
          content: options.prompt,
          provenance: { kind: "user_input" },
        }),
      );
      if (options.signal?.aborted) {
        onAbort();
      }
      await submission;
      return output.result();
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  } catch {
    // ConversationRuntime publishes run_error before rejecting submit(), so
    // the stable output event has already captured the failure.
    return output.result();
  } finally {
    unsubscribe();
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function resolveHeadlessPrompt(
  prompt: string | undefined,
  stdin?: AsyncIterable<unknown> & { isTTY?: boolean },
): Promise<string> {
  const argumentPrompt = prompt?.trim();
  if (argumentPrompt) {
    return argumentPrompt;
  }
  if ((stdin ?? process.stdin).isTTY) {
    throw new Error("Kana exec requires a prompt argument or prompt text on stdin.");
  }

  let input = "";
  if (stdin === undefined) {
    // Bun's process.stdin async iterator can be empty for regular-file
    // redirection after node:process is loaded by CLI dependencies. Bun.stdin
    // reads both pipes and redirected files directly from file descriptor 0.
    input = await Bun.stdin.text();
  } else {
    for await (const chunk of stdin) {
      input +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    }
  }
  const stdinPrompt = input.trim();
  if (!stdinPrompt) {
    throw new Error("Kana exec received an empty prompt.");
  }
  return stdinPrompt;
}

function createHeadlessRuntime(
  host: ReturnType<typeof createKanaConversationHost>,
): ConversationRuntime {
  return new ConversationRuntime({
    initialSession: host.initialSession
      ? {
          id: host.initialSession.metadata.id,
          messages: host.initialSession.messages,
          timeline: host.initialSession.timeline,
          todoState: host.initialSession.todoState,
          contextCheckpoint: host.initialSession.contextCheckpoint,
        }
      : undefined,
    createAgent: (agentOptions) => host.createAgent(agentOptions),
    createNewSession: () => host.createNewSession(),
    forkSession: (messages, contextCheckpoint, prompt) =>
      host.forkSession(messages, contextCheckpoint, prompt),
    loadSession: (sessionId) => {
      const session = host.loadSession(sessionId);
      return {
        id: session.metadata.id,
        messages: session.messages,
        timeline: session.timeline,
        todoState: session.todoState,
        contextCheckpoint: session.contextCheckpoint,
      };
    },
    wakeScheduler: host.wakeScheduler,
    scheduledRuns: false,
    getLogger: () => host.getLogger(),
  });
}

function createHeadlessApprovalHook(
  options: RunHeadlessConversationOptions,
  output: HeadlessRunOutput,
): BeforeToolExecutionHook {
  return ({ toolCall }) => {
    if (
      options.allowAllTools ||
      !shouldRequestToolApproval(options.approvalConfig, options.toolApprovals, toolCall)
    ) {
      return { type: "continue" };
    }

    const message = `Tool ${toolCall.name} requires interactive approval. Re-run with --allow-all-tools to authorize it.`;
    output.approvalDenied(message);
    return {
      type: "cancel",
      abortRun: true,
      message,
    };
  };
}

type HeadlessRunOutputOptions = {
  json: boolean;
  stdout: HeadlessOutputStream;
  stderr: HeadlessOutputStream;
  getTermination(): HeadlessRunTermination | undefined;
};

class HeadlessRunOutput {
  private outcome?: AgentEndReason;
  private finalMessage?: string;
  private usage?: ModelUsage;
  private termination?: HeadlessRunTermination;
  private runFailed = false;

  constructor(private readonly options: HeadlessRunOutputOptions) {}

  startSession(sessionId: string | undefined): void {
    if (!sessionId) {
      throw new Error("Kana exec could not create an active session.");
    }
    this.emit(
      createKanaExecEvent({
        type: "session.started",
        session_id: sessionId,
      }),
      `Session: ${sessionId}`,
    );
  }

  warning(warning: HeadlessWarning): void {
    this.emit(
      createKanaExecEvent({
        type: "warning",
        phase: warning.phase,
        message: warning.message,
        ...(warning.serverId === undefined ? {} : { server_id: warning.serverId }),
      }),
      `Warning: ${warning.message}`,
    );
  }

  approvalDenied(message: string): void {
    if (!this.options.json) {
      this.write(this.options.stderr, `${sanitizeTerminalText(message)}\n`);
    }
  }

  handle(event: ConversationRuntimeEvent): void {
    switch (event.type) {
      case "run_start":
        this.emit(createKanaExecEvent({ type: "run.started" }), "Running...");
        return;
      case "run_end":
        if (!event.event) {
          return;
        }
        this.termination = this.options.getTermination();
        // The headless cancellation cause wins a narrow race where the core
        // Agent reaches its terminal event immediately after cancellation.
        this.outcome = this.termination === undefined ? event.event.reason : "aborted";
        this.emit(
          createKanaExecEvent({
            type: "run.completed",
            outcome: this.outcome,
            ...(this.usage === undefined ? {} : { usage: toKanaExecUsage(this.usage) }),
            ...(this.termination === undefined
              ? {}
              : { termination: toKanaExecRunTermination(this.termination) }),
          }),
        );
        if (!this.options.json && this.termination?.reason === "timeout") {
          this.write(
            this.options.stderr,
            `Kana exec timed out after ${this.termination.timeoutMs}ms.\n`,
          );
        }
        if (!this.options.json && this.finalMessage) {
          this.write(this.options.stdout, `${sanitizeTerminalOutput(this.finalMessage)}\n`);
        }
        return;
      case "run_error": {
        this.runFailed = true;
        this.termination = this.options.getTermination();
        const error = normalizeError(event.error);
        this.emit(
          createKanaExecEvent({
            type: "run.failed",
            error,
            ...(this.termination === undefined
              ? {}
              : { termination: toKanaExecRunTermination(this.termination) }),
          }),
          `Error: ${error.message}`,
        );
        return;
      }
      case "agent_event":
        this.handleAgentEvent(event.event);
        return;
      case "session_changed":
      case "todo_state_changed":
        return;
    }
  }

  result(): HeadlessRunResult {
    return {
      exitCode: this.exitCode(),
      outcome: this.outcome,
      termination: this.termination,
      finalMessage: this.finalMessage,
      usage: this.usage,
    };
  }

  private handleAgentEvent(
    event: Extract<ConversationRuntimeEvent, { type: "agent_event" }>["event"],
  ): void {
    switch (event.type) {
      case "turn_start":
        this.emit(
          createKanaExecEvent({
            type: "model_turn.started",
            turn: event.turn,
          }),
        );
        return;
      case "turn_end":
        this.recordUsage(event.message.usage);
        this.emit(
          createKanaExecEvent({
            type: "model_turn.completed",
            turn: event.turn,
            ...(event.message.stopReason === undefined
              ? {}
              : { stop_reason: event.message.stopReason }),
            ...(event.message.usage === undefined
              ? {}
              : { usage: toKanaExecUsage(event.message.usage) }),
          }),
        );
        return;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.emit(
            createKanaExecEvent({
              type: "assistant.delta",
              delta: event.assistantMessageEvent.delta,
            }),
          );
        }
        return;
      case "message_end": {
        const text = visibleAssistantText(event.message);
        this.finalMessage = text;
        this.emit(
          createKanaExecEvent({
            type: "assistant.completed",
            text,
            ...(event.message.usage === undefined
              ? {}
              : { usage: toKanaExecUsage(event.message.usage) }),
          }),
        );
        return;
      }
      case "tool_execution_start":
        this.emit(
          createKanaExecEvent({
            type: "tool.started",
            tool_call_id: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
          }),
          `Tool started: ${event.toolName}`,
        );
        return;
      case "tool_execution_update":
        this.emit(
          createKanaExecEvent({
            type: "tool.updated",
            tool_call_id: event.toolCallId,
            name: event.toolName,
            partial_result: event.partialResult,
          }),
        );
        return;
      case "tool_execution_end":
        this.emit(
          createKanaExecEvent({
            type: "tool.completed",
            tool_call_id: event.toolCallId,
            name: event.toolName,
            result: event.result,
            is_error: event.isError,
          }),
          `Tool ${event.isError ? "failed" : "completed"}: ${event.toolName}`,
        );
        return;
      case "context_compaction_start":
        this.emit(
          createKanaExecEvent({
            type: "context.compaction_started",
            reason: event.reason,
            estimated_tokens: event.estimatedTokens,
            context_limit: event.contextLimit,
          }),
          "Compacting context...",
        );
        return;
      case "context_compacted":
        this.recordUsage(event.usage);
        this.emit(
          createKanaExecEvent({
            type: "context.compacted",
            reason: event.reason,
            before_tokens: event.beforeTokens,
            estimated_after_tokens: event.estimatedAfterTokens,
            compacted_message_count: event.compactedMessageCount,
            context_limit: event.contextLimit,
            ...(event.usage === undefined ? {} : { usage: toKanaExecUsage(event.usage) }),
          }),
          "Context compacted.",
        );
        return;
      case "agent_start":
      case "agent_end":
      case "message_start":
      case "turn_input":
        return;
    }
  }

  private recordUsage(usage: ModelUsage | undefined): void {
    if (usage) {
      this.usage = addModelUsage(this.usage, usage);
    }
  }

  private exitCode(): number {
    if (this.runFailed) {
      return 1;
    }
    switch (this.termination?.reason) {
      case "timeout":
        return 124;
      case "sigint":
        return 130;
      default:
        return this.outcome === "stop" ? 0 : 1;
    }
  }

  private emit(event: KanaExecEvent, humanMessage?: string): void {
    if (this.options.json) {
      this.write(this.options.stdout, `${stringifyJsonLine(event)}\n`);
      return;
    }
    if (humanMessage) {
      this.write(this.options.stderr, `${sanitizeTerminalText(humanMessage)}\n`);
    }
  }

  private write(stream: HeadlessOutputStream, chunk: string): void {
    stream.write(chunk);
  }
}

function createHeadlessSignalReason(termination: HeadlessRunTermination): HeadlessSignalReason {
  return { [HEADLESS_SIGNAL_REASON]: termination };
}

function readHeadlessSignalReason(
  signal: AbortSignal | undefined,
): HeadlessRunTermination | undefined {
  if (!signal?.aborted || typeof signal.reason !== "object" || signal.reason === null) {
    return undefined;
  }
  const reason = signal.reason as Partial<HeadlessSignalReason>;
  return reason[HEADLESS_SIGNAL_REASON];
}

function toKanaExecRunTermination(termination: HeadlessRunTermination): KanaExecRunTermination {
  return termination.reason === "timeout"
    ? { reason: "timeout", timeout_ms: termination.timeoutMs }
    : { reason: "sigint" };
}

function visibleAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function warningsFromMcpDiagnostics(
  diagnostics: readonly McpServerDiagnostic[],
): HeadlessWarning[] {
  return diagnostics.flatMap((diagnostic) => {
    if (diagnostic.status !== "failed") {
      return [];
    }
    return [
      {
        phase: "mcp_startup",
        serverId: diagnostic.id,
        message: `MCP server ${diagnostic.id} failed to start: ${
          diagnostic.error?.message ?? "Unknown startup error."
        }`,
      },
    ];
  });
}

function writeStartupError(error: unknown, json: boolean): void {
  const normalized = normalizeError(error);
  if (json) {
    process.stdout.write(
      `${stringifyJsonLine(
        createKanaExecEvent({
          type: "error",
          phase: "startup",
          error: normalized,
        }),
      )}\n`,
    );
    return;
  }
  process.stderr.write(`Error: ${sanitizeTerminalText(normalized.message)}\n`);
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

function stringifyJsonLine(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").replace(/\r?\n/g, " ");
}

function sanitizeTerminalOutput(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
