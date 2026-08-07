import type { AgentEndReason, BeforeToolExecutionHook } from "@/agent";
import { type AssistantMessage, addModelUsage, type ModelUsage } from "@/core";
import {
  ConversationRuntime,
  type ConversationRuntimeEvent,
  createKanaConversationHost,
  type KanaLaunchMode,
  type KanaToolApprovalConfig,
  type KanaToolApprovals,
  shouldRequestToolApproval,
} from "@/kana";
import type { McpServerDiagnostic } from "@/mcp";
import { createKanaExecEvent, type KanaExecEvent, toKanaExecUsage } from "./protocol";

export type StartHeadlessOptions = {
  prompt?: string;
  resumeSessionId?: string;
  launchMode?: KanaLaunchMode;
  json?: boolean;
  allowAllTools?: boolean;
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
  stdout?: HeadlessOutputStream;
  stderr?: HeadlessOutputStream;
};

export type HeadlessRunResult = {
  exitCode: number;
  outcome?: AgentEndReason;
  finalMessage?: string;
  usage?: ModelUsage;
};

export type HeadlessWarning = {
  phase: "mcp_startup";
  message: string;
  serverId?: string;
};

export async function startHeadless(options: StartHeadlessOptions = {}): Promise<number> {
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
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
    controller.abort(new Error("Kana exec was interrupted."));
    runtime?.abort();
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
    });
    const exitCode = interrupted ? 130 : result.exitCode;
    host.getLogger().info("headless.completed", {
      outcome: result.outcome ?? "failed",
      exitCode,
    });
    return exitCode;
  } catch (error) {
    host?.getLogger().error("headless.failed", {
      phase: runtime === undefined ? "initialization" : "mcp_startup",
      error,
    });
    writeStartupError(error, options.json ?? false);
    return interrupted ? 130 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    await runtime?.close();
    await host?.closeMcp();
  }
}

export async function runHeadlessConversation(
  options: RunHeadlessConversationOptions,
): Promise<HeadlessRunResult> {
  const output = new HeadlessRunOutput({
    json: options.json ?? false,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  });
  output.startSession(options.runtime.sessionId);
  for (const warning of options.warnings ?? []) {
    output.warning(warning);
  }

  const beforeToolExecution = createHeadlessApprovalHook(options, output);
  options.runtime.setBeforeToolExecution(beforeToolExecution);
  const onAbort = (): void => {
    options.runtime.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const unsubscribe = options.runtime.subscribe((event) => {
    output.handle(event);
  });

  try {
    const submission = options.runtime.submit({
      role: "user",
      content: options.prompt,
    });
    if (options.signal?.aborted) {
      options.runtime.abort();
    }
    await submission;
    return output.result();
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
  stdin: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  const argumentPrompt = prompt?.trim();
  if (argumentPrompt) {
    return argumentPrompt;
  }
  if (stdin.isTTY) {
    throw new Error("Kana exec requires a prompt argument or prompt text on stdin.");
  }

  let input = "";
  for await (const chunk of stdin) {
    input += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
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
};

class HeadlessRunOutput {
  private outcome?: AgentEndReason;
  private finalMessage?: string;
  private usage?: ModelUsage;
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
        this.outcome = event.event.reason;
        this.emit(
          createKanaExecEvent({
            type: "run.completed",
            outcome: event.event.reason,
            ...(this.usage === undefined ? {} : { usage: toKanaExecUsage(this.usage) }),
          }),
        );
        if (!this.options.json && this.finalMessage) {
          this.write(this.options.stdout, `${sanitizeTerminalOutput(this.finalMessage)}\n`);
        }
        return;
      case "run_error": {
        this.runFailed = true;
        const error = normalizeError(event.error);
        this.emit(
          createKanaExecEvent({
            type: "run.failed",
            error,
          }),
          `Error: ${error.message}`,
        );
        return;
      }
      case "agent_event":
        this.handleAgentEvent(event.event);
        return;
      case "session_changed":
        return;
    }
  }

  result(): HeadlessRunResult {
    return {
      exitCode: !this.runFailed && this.outcome === "stop" ? 0 : 1,
      outcome: this.outcome,
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
