import { type ConversationRuntime, createKanaConversationHost, type KanaLaunchMode } from "@/kana";
import type { McpServerDiagnostic } from "@/mcp";
import { createHeadlessSignalReason, readHeadlessSignalReason } from "./run-lifecycle";
import { type HeadlessWarning, writeHeadlessStartupError } from "./run-output";
import { createHeadlessRuntime, runHeadlessConversation } from "./runner";
import { assertValidHeadlessTimeoutMs } from "./timeout";

export type StartHeadlessOptions = {
  prompt?: string;
  resumeSessionId?: string;
  launchMode?: KanaLaunchMode;
  goal?: boolean;
  json?: boolean;
  allowAllTools?: boolean;
  timeoutMs?: number;
};

export async function startHeadless(options: StartHeadlessOptions = {}): Promise<number> {
  try {
    assertValidHeadlessTimeoutMs(options.timeoutMs);
  } catch (error) {
    writeHeadlessStartupError(error, options.json ?? false);
    return 1;
  }

  if (options.launchMode === "clean" && options.resumeSessionId !== undefined) {
    writeHeadlessStartupError(
      new Error("Clean mode cannot resume saved sessions because its session is temporary."),
      options.json ?? false,
    );
    return 1;
  }

  let prompt: string;
  try {
    prompt = await resolveHeadlessPrompt(options.prompt);
  } catch (error) {
    writeHeadlessStartupError(error, options.json ?? false);
    return 1;
  }

  const controller = new AbortController();
  const onInterrupt = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(createHeadlessSignalReason({ reason: "sigint" }));
    }
  };
  process.once("SIGINT", onInterrupt);

  let runtime: ConversationRuntime | undefined;
  let host: ReturnType<typeof createKanaConversationHost> | undefined;
  try {
    host = createKanaConversationHost({
      session: options.resumeSessionId
        ? { type: "resume", sessionId: options.resumeSessionId }
        : { type: "new" },
      // A one-shot process cannot honor a future process-local wake after exit.
      enableScheduledWakeTool: false,
      launchMode: options.launchMode,
    });
    runtime = createHeadlessRuntime(host, options.goal ?? false);
    host.getLogger().info("headless.started", {
      launchMode: options.launchMode ?? "normal",
      outputMode: options.json ? "jsonl" : "human",
      runMode: options.goal ? "goal" : "turn",
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
      goal: options.goal,
      approvalConfig: host.approvalConfig,
      toolApprovals: host.toolApprovals,
      allowAllTools: options.allowAllTools,
      json: options.json,
      warnings: warningsFromMcpDiagnostics(mcpSnapshot.diagnostics),
      signal: controller.signal,
      timeoutMs: options.timeoutMs,
      logger: host.getLogger(),
    });
    host.getLogger().info("headless.completed", {
      outcome: result.outcome ?? "failed",
      exitCode: result.exitCode,
      ...(result.goal === undefined ? {} : { goalStatus: result.goal.status }),
      ...(result.termination === undefined ? {} : { terminationReason: result.termination.reason }),
    });
    return result.exitCode;
  } catch (error) {
    host?.getLogger().error("headless.failed", {
      phase: runtime === undefined ? "initialization" : "mcp_startup",
      error,
    });
    writeHeadlessStartupError(error, options.json ?? false);
    return readHeadlessSignalReason(controller.signal)?.reason === "sigint" ? 130 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    await closeHeadlessResources(runtime, host);
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
    // Bun.stdin handles pipes and regular-file redirection after node:process loads.
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

async function closeHeadlessResources(
  runtime: ConversationRuntime | undefined,
  host: ReturnType<typeof createKanaConversationHost> | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await runtime?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await host?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Headless cleanup failed.");
  }
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
