import {
  createKanaConversationHost,
  getKanaModelManagement,
  type KanaConversationHostSession,
  type KanaLaunchMode,
  loadKanaSkillActivations,
  openKanaOAuthAuthorizationUrl,
  saveEnabledGlobalSkillNames,
} from "@/kana";
import { KanaTuiApp } from "./app/app";
import { applyTuiModelSelection, type TuiModelSelection } from "./app/model-selection";
import {
  formatMcpLifecycleStatus,
  formatMcpReloadSummary,
  formatMcpStartupSummary,
  formatMcpStartupWarnings,
} from "./mcp-lifecycle-status";
import { registerTuiProcessSignals } from "./process-lifecycle";
import { ProcessTerminal } from "./runtime";

export type StartTuiOptions = {
  initialPrompt?: string;
  resumeSessionId?: string;
  showResumePicker?: boolean;
  launchMode?: KanaLaunchMode;
};

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  const cleanMode = options.launchMode === "clean";
  if (cleanMode && (options.resumeSessionId !== undefined || options.showResumePicker)) {
    throw new Error("Clean mode cannot resume saved sessions because its session is temporary.");
  }
  let app: KanaTuiApp | undefined;
  let updateMcpLifecycleStatus: ((status: string) => void) | undefined;
  const session: KanaConversationHostSession = options.showResumePicker
    ? { type: "none" }
    : options.resumeSessionId
      ? { type: "resume", sessionId: options.resumeSessionId }
      : { type: "new" };
  const host = createKanaConversationHost<TuiModelSelection>({
    launchMode: options.launchMode,
    session,
    applyAgentConfiguration: applyTuiModelSelection,
    openMcpOAuthAuthorizationUrl: async (serverId, url) => {
      app?.showMcpOAuthAuthorization(serverId, url);
      await openKanaOAuthAuthorizationUrl(url, {
        getLogger: () => host.getLogger(),
      });
    },
    onMcpOAuthDiagnostic: (serverId, event) => {
      app?.handleMcpOAuthDiagnostic(serverId, event);
    },
    onMcpProgress: (event) => {
      const status = formatMcpLifecycleStatus(event, event.runtimeOperation);
      if (status === undefined) {
        return;
      }

      if (event.runtimeOperation !== "close") {
        updateMcpLifecycleStatus?.(status);
      } else {
        app?.showShutdownStatus(status);
      }
    },
  });
  const terminal = new ProcessTerminal(host.notificationConfig);
  let removeProcessSignals = (): void => {};
  const closeHostRuntime = async (): Promise<void> => {
    removeProcessSignals();
    await host.close();
  };
  const runMcpRuntimeOperation = async (
    operation: "start" | "reload",
    onProgress: (status: string) => void,
    signal: AbortSignal,
  ): Promise<{ status?: string; warnings: string[] }> => {
    updateMcpLifecycleStatus = onProgress;
    try {
      const snapshot = await (operation === "start"
        ? host.startMcp(signal)
        : host.reloadMcp(signal));
      return {
        status:
          operation === "start"
            ? formatMcpStartupSummary(snapshot.diagnostics, snapshot.tools.length)
            : formatMcpReloadSummary(snapshot.diagnostics, snapshot.tools.length),
        warnings: formatMcpStartupWarnings(snapshot.diagnostics),
      };
    } finally {
      updateMcpLifecycleStatus = undefined;
    }
  };
  const loadMcpTools = (onProgress: (status: string) => void, signal: AbortSignal) =>
    runMcpRuntimeOperation("start", onProgress, signal);
  const reloadMcpTools = (onProgress: (status: string) => void, signal: AbortSignal) =>
    runMcpRuntimeOperation("reload", onProgress, signal);

  app = await createTuiAppWithCleanup(
    closeHostRuntime,
    (agentOptions) =>
      host.createAgent({
        ...agentOptions,
        configuration: agentOptions.modelSelection,
      }),
    terminal,
    {
      launch: {
        mode: options.launchMode,
        initialPrompt: options.initialPrompt,
        startInResumePicker: options.showResumePicker,
      },
      conversation: {
        initialSession: host.initialSession
          ? {
              id: host.initialSession.metadata.id,
              messages: host.initialSession.messages,
              timeline: host.initialSession.timeline,
              todoState: host.initialSession.todoState,
              contextCheckpoint: host.initialSession.contextCheckpoint,
            }
          : undefined,
        getResumeSessionId: () => host.resumeSessionId,
        createNewSession: () => host.createNewSession(),
        forkSession: (messages, contextCheckpoint, prompt) =>
          host.forkSession(messages, contextCheckpoint, prompt),
        listSessions: () => host.listSessions(),
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
        deleteSession: (sessionId) => host.deleteSession(sessionId),
        goalMaxRounds: host.config.agent.goalMaxRounds,
        wakeScheduler: host.wakeScheduler,
        getBackgroundJobs: (sessionId) => host.getBackgroundJobs(sessionId),
        disposeSession: (sessionId, source, foregroundSettled) =>
          host.disposeSession(sessionId, source, foregroundSettled),
      },
      skills: {
        load: () => loadKanaSkillActivations({ cwd: process.cwd() }),
        saveEnabledGlobalNames: (names) => saveEnabledGlobalSkillNames(names),
      },
      toolApproval: {
        config: host.approvalConfig,
        approvals: host.toolApprovals,
        resolveToolSource: (toolName) => {
          const source = host.getMcpToolSource(toolName);
          return source === undefined ? undefined : { kind: "mcp", ...source };
        },
      },
      ui: {
        notification: host.notificationConfig,
        config: host.tuiConfig,
      },
      memory: {
        compact: (target, userRequest, signal) => host.compactMemory(target, userRequest, signal),
        load: (target) => host.loadMemory(target),
      },
      usage: {
        load: (scope) => host.loadUsage(scope),
      },
      models: {
        getSettings: () => getKanaModelManagement(host.config),
      },
      // Clean mode must not parse MCP configuration or create external
      // processes, including during later session and Agent rebuilds.
      ...(cleanMode
        ? {}
        : {
            externalTools: {
              load: loadMcpTools,
              mcp: {
                loadServers: () => host.loadMcpServers(),
                saveEnabledServerIds: (serverIds: string[]) =>
                  host.saveEnabledMcpServerIds(serverIds),
                authorizeServer: (
                  serverId: string,
                  onAuthorizationUrl: (url: string) => void,
                  signal: AbortSignal,
                ) =>
                  host.authorizeMcpServer(
                    serverId,
                    async (url) => {
                      onAuthorizationUrl(url);
                      await openKanaOAuthAuthorizationUrl(url, {
                        getLogger: () => host.getLogger(),
                      });
                    },
                    signal,
                  ),
                signOutServer: (serverId: string) => host.signOutMcpServer(serverId),
                reload: reloadMcpTools,
              },
            },
          }),
      diagnostics: {
        getLogger: () => host.getLogger(),
      },
      lifecycle: {
        stop: closeHostRuntime,
        forceStop: () => {
          removeProcessSignals();
          terminal.stop();
          process.kill(process.pid, "SIGINT");
        },
      },
    },
  );

  removeProcessSignals = registerTuiProcessSignals((signal) => {
    host.getLogger().info("tui.signal_received", { signal });
    void app?.stop();
  });

  try {
    app.start();
  } catch (error) {
    await app.stop();
    throw error;
  }
  await app.waitForStop();
}

async function createTuiAppWithCleanup(
  cleanup: () => Promise<void>,
  ...args: ConstructorParameters<typeof KanaTuiApp>
): Promise<KanaTuiApp> {
  try {
    return new KanaTuiApp(...args);
  } catch (error) {
    await cleanup();
    throw error;
  }
}
