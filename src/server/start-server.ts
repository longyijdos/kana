import { ConversationRuntime, createKanaConversationHost, type KanaLaunchMode } from "@/kana";
import { createServerApi } from "./api";

export type StartServerOptions = {
  port?: number;
  launchMode?: KanaLaunchMode;
  configOverrides?: readonly string[];
};

export async function startServer(options: StartServerOptions = {}): Promise<void> {
  const token = process.env.KANA_SERVER_TOKEN;
  if (!token?.trim()) throw new Error("KANA_SERVER_TOKEN is required.");
  const port = options.port ?? 8318;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Server port must be an integer between 1 and 65535.");
  }

  const host = createKanaConversationHost({
    session: { type: "new" },
    launchMode: options.launchMode,
    configOverrides: options.configOverrides,
  });
  let runtime: ConversationRuntime | undefined;
  let api: ReturnType<typeof createServerApi> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let stopping = false;
  let signalReceived!: () => void;
  const stopped = new Promise<void>((resolve) => {
    signalReceived = resolve;
  });
  const onSignal = () => {
    stopping = true;
    signalReceived();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    runtime = new ConversationRuntime({
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
      forkSession: (messages, checkpoint, prompt) => host.forkSession(messages, checkpoint, prompt),
      loadSession: (id) => {
        const session = host.loadSession(id);
        return {
          id: session.metadata.id,
          messages: session.messages,
          timeline: session.timeline,
          contextCheckpoint: session.contextCheckpoint,
          todoState: session.todoState,
        };
      },
      listSessions: () => host.listSessions(),
      deleteSession: (id) => host.deleteSession(id),
      getBackgroundJobs: (id) => host.getBackgroundJobs(id),
      getSubagents: (id) => host.getSubagents(id),
      disposeSession: (id, source, settled) => host.disposeSession(id, source, settled),
      wakeScheduler: host.wakeScheduler,
      goalMaxRounds: host.config.agent.goalMaxRounds,
      backgroundJobCompletionRuns: true,
      subagentCompletionRuns: true,
      scheduledRuns: true,
      getLogger: () => host.getLogger(),
    });
    host.getLogger().info("server.starting", { port });
    const mcp = await host.startMcp();
    if (stopping) return;
    runtime.reconfigure();
    for (const diagnostic of mcp.diagnostics) {
      if (diagnostic.status !== "ready") {
        console.error(`MCP server ${diagnostic.id}: ${diagnostic.status}`);
      }
    }
    api = createServerApi({
      token,
      runtime,
      launchMode: options.launchMode,
      getApprovalConfig: () => host.approvalConfig,
      getApprovals: () => host.toolApprovals,
      addTrustedShellCommand: (command) => {
        host.addTrustedShellCommand(command);
      },
      getLogger: () => host.getLogger(),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      maxRequestBodySize: 1_048_576,
      fetch: api.fetch,
    });
    host.getLogger().info("server.started", { port });
    console.error(`Kana API listening on http://127.0.0.1:${port} (experimental)`);
    await stopped;
  } catch (error) {
    host
      .getLogger()
      .error("server.failed", { errorType: error instanceof Error ? error.name : "Error" });
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    host.getLogger().info("server.stopping");
    api?.close();
    await server?.stop(true);
    try {
      await runtime?.close();
    } finally {
      await host.close();
    }
  }
}
