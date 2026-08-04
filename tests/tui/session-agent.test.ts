import { describe, expect, test } from "bun:test";
import { AgentEventStream } from "../../src/agent";
import { createWakeScheduler, type KanaSessionMetadata } from "../../src/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { stripAnsi } from "../../src/tui/render";
import type { Terminal } from "../../src/tui/runtime";

describe("session-scoped agents", () => {
  test("resets a temporary tool approval mode when the session changes", () => {
    const app = new KanaTuiApp(() => createAgentStub(), createTerminal(), createOptions());
    const internal = app as unknown as {
      handleCommand(command: { name: "new"; arguments: string; raw: string }): void;
      toolApproval: {
        mode: string;
        setTemporaryMode(mode: "never"): void;
      };
    };

    internal.toolApproval.setTemporaryMode("never");
    expect(internal.toolApproval.mode).toBe("never");

    internal.handleCommand({ name: "new", arguments: "", raw: "/new" });

    expect(internal.toolApproval.mode).toBe("unless_trusted");
  });

  test("cancels the active Agent before running host shutdown once", async () => {
    const events: string[] = [];
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    let shutdownRender = "";
    let app!: KanaTuiApp;
    app = new KanaTuiApp(
      () =>
        ({
          state: {
            messages: [],
            model: {
              metadata: {
                provider: "test",
                model: "test-model",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1,
                maxOutputTokens: 1,
              },
            },
          },
          abort() {
            events.push("agent.abort");
          },
          async waitForIdle() {
            events.push("agent.waitForIdle");
            await idle;
          },
        }) as never,
      {
        ...createTerminal(),
        stop: () => events.push("terminal.stop"),
      },
      {
        ...createOptions(),
        onStop: async () => {
          app.showShutdownStatus("Closing MCP servers... 0/1");
          shutdownRender = (
            app as unknown as { layout: { render(width: number): string[] } }
          ).layout
            .render(80)
            .join("\n");
          events.push("host.stop");
        },
      },
    );

    const firstStop = app.stop();
    const secondStop = app.stop();

    expect(secondStop).toBe(firstStop);
    expect(events).toEqual(["agent.abort", "agent.waitForIdle"]);
    expect(
      (app as unknown as { layout: { render(width: number): string[] } }).layout
        .render(80)
        .join("\n"),
    ).toContain("Shutting down Kana...");
    expect(
      (app as unknown as { layout: { render(width: number): string[] } }).layout
        .render(80)
        .join("\n"),
    ).toContain("test-model");

    releaseIdle();
    await firstStop;
    await app.waitForStop();

    expect(shutdownRender).toContain("Closing MCP servers... 0/1");
    expect(events).toEqual(["agent.abort", "agent.waitForIdle", "host.stop", "terminal.stop"]);
  });

  test("loads external tools inside the visible session before enabling the editor", async () => {
    let resolveLoad!: (result: { status: string; warnings: string[] }) => void;
    const loadResult = new Promise<{ status: string; warnings: string[] }>((resolve) => {
      resolveLoad = resolve;
    });
    let reportProgress!: (status: string) => void;
    let toolsLoaded = false;
    const agentToolStates: boolean[] = [];
    const app = new KanaTuiApp(
      () => {
        agentToolStates.push(toolsLoaded);
        return createAgentStub();
      },
      createTerminal(),
      {
        ...createOptions(),
        loadExternalTools: (onProgress) => {
          reportProgress = onProgress;
          return loadResult;
        },
      },
    );
    const internal = app as unknown as {
      transcript: { render(width: number): string[] };
      layout: { render(width: number): string[] };
      editor: unknown;
      tui: { getFocus(): unknown };
    };

    app.start();

    expect(renderTranscript(internal.transcript)).toContain("Kana v");
    expect(renderTranscript(internal.transcript)).toContain("Starting external tools...");
    expect(stripAnsi(internal.layout.render(80).join("\n"))).toContain("test-model");
    expect(internal.tui.getFocus()).toBeUndefined();
    expect(agentToolStates).toEqual([false]);

    reportProgress("Starting MCP servers... 0/1");
    expect(renderTranscript(internal.transcript)).toContain("Starting MCP servers... 0/1");

    toolsLoaded = true;
    resolveLoad({
      status: "MCP startup complete: 1/2 servers ready · 3 tools",
      warnings: ["MCP server optional failed to start: unavailable"],
    });
    await waitFor(() => agentToolStates.length === 2);

    const transcript = renderTranscript(internal.transcript);
    expect(agentToolStates).toEqual([false, true]);
    expect(transcript).not.toContain("Starting MCP servers...");
    expect(transcript).toContain("MCP startup complete: 1/2 servers ready · 3 tools");
    expect(transcript).toContain("MCP server optional failed to start: unavailable");
    expect(internal.tui.getFocus()).toBe(internal.editor);
  });

  test("keeps the visible session disabled when required external tools fail", async () => {
    const app = new KanaTuiApp(() => createAgentStub(), createTerminal(), {
      ...createOptions(),
      loadExternalTools: async () => {
        throw new Error("Required MCP servers failed to start: filesystem.");
      },
    });
    const internal = app as unknown as {
      transcript: { render(width: number): string[] };
      tui: { getFocus(): unknown };
    };

    app.start();
    await waitFor(() =>
      renderTranscript(internal.transcript).includes("Failed to load external tools"),
    );

    expect(renderTranscript(internal.transcript)).toContain(
      "Required MCP servers failed to start: filesystem.",
    );
    expect(renderTranscript(internal.transcript)).toContain("Press Ctrl+C to exit.");
    expect(internal.tui.getFocus()).toBeUndefined();
  });

  test("defers external-tool loading until a resume-picker session is selected", async () => {
    const session: KanaSessionMetadata = {
      id: "session-a",
      createdAt: "2026-07-20T00:00:00.000Z",
      title: "Existing session",
      cwd: "/repo",
      path: "/sessions/session-a.jsonl",
    };
    let loadCount = 0;
    const app = new KanaTuiApp(() => createAgentStub(), createTerminal(), {
      ...createOptions(),
      startInResumePicker: true,
      listSessions: () => [session],
      loadSession: () => ({ id: session.id, messages: [], timeline: [] }),
      loadExternalTools: async () => {
        loadCount += 1;
        return {};
      },
    });
    const internal = app as unknown as {
      tui: { getFocus(): { handleInput?(data: string): void } | undefined };
    };

    app.start();

    expect(loadCount).toBe(0);
    internal.tui.getFocus()?.handleInput?.("\r");
    await waitFor(() => loadCount === 1);

    expect(loadCount).toBe(1);
  });

  test("keeps customization controls and external tools disabled in clean mode", async () => {
    let externalToolLoadCount = 0;
    const app = new KanaTuiApp(() => createAgentStub(), createTerminal(), {
      ...createOptions(),
      launchMode: "clean",
      loadExternalTools: async () => {
        externalToolLoadCount += 1;
        return {};
      },
    });
    const internal = app as unknown as {
      handleCommand(command: {
        name: "skills" | "mcp" | "memory" | "resume" | "delete";
        arguments: string;
        raw: string;
      }): void;
      layout: { render(width: number): string[] };
      transcript: { render(width: number): string[] };
    };

    app.start();
    internal.handleCommand({ name: "skills", arguments: "", raw: "/skills" });
    internal.handleCommand({ name: "mcp", arguments: "", raw: "/mcp" });
    internal.handleCommand({ name: "memory", arguments: "", raw: "/memory" });
    internal.handleCommand({ name: "resume", arguments: "saved-session", raw: "/resume" });
    internal.handleCommand({ name: "delete", arguments: "", raw: "/delete" });

    const transcript = renderTranscript(internal.transcript);
    expect(externalToolLoadCount).toBe(0);
    expect(transcript).toContain(
      "Clean mode · temporary session; customizations and saving are disabled.",
    );
    expect(transcript).toContain("Skills are unavailable in clean mode.");
    expect(transcript).toContain("MCP management is unavailable in clean mode.");
    expect(transcript).toContain("Memory is unavailable in clean mode.");
    expect(transcript.match(/Saved sessions are unavailable in clean mode\./g)).toHaveLength(2);
    expect(stripAnsi(internal.layout.render(120).join("\n"))).toContain("clean");
  });

  test("uses the second Ctrl+C to force stop while graceful MCP shutdown is pending", async () => {
    let handleInput!: (data: string) => void;
    let releaseShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    let forceStopCount = 0;
    const terminal = {
      ...createTerminal(),
      start: (onInput: (data: string) => void) => {
        handleInput = onInput;
      },
    };
    const app = new KanaTuiApp(() => createAgentStub(), terminal, {
      ...createOptions(),
      loadExternalTools: () => new Promise(() => {}),
      onStop: () => shutdown,
      onForceStop: () => {
        forceStopCount += 1;
      },
    });
    const internal = app as unknown as {
      layout: { render(width: number): string[] };
    };

    app.start();
    handleInput("\x03");
    await Promise.resolve();

    expect(stripAnsi(internal.layout.render(80).join("\n"))).toContain(
      "Press Ctrl+C again to force quit.",
    );
    expect(forceStopCount).toBe(0);

    handleInput("\x03");
    expect(forceStopCount).toBe(1);

    releaseShutdown();
    await app.waitForStop();
  });

  test("recreates the agent after forking so the new session owns later run state", async () => {
    const createdMessages: unknown[][] = [];
    const app = new KanaTuiApp(
      (options) => {
        createdMessages.push(options.messages ?? []);
        return {
          state: {
            messages: [{ role: "user", content: "original" }],
            model: {
              metadata: {
                provider: "test",
                model: "test-model",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1,
                maxOutputTokens: 1,
              },
            },
          },
          abort() {},
        } as never;
      },
      createTerminal(),
      createOptions(),
    );
    const internal = app as unknown as {
      forkSession(prompt: string): Promise<void>;
      submitPrompt(value: string): Promise<void>;
    };
    internal.submitPrompt = async () => {};

    await internal.forkSession("Continue on the fork.");

    expect(createdMessages).toEqual([[], [{ role: "user", content: "original" }]]);
  });

  test("queues due wake events until the active agent run ends", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const calls: Array<{ input: unknown; stream: AgentEventStream }> = [];
    const wakeScheduler = createWakeScheduler({
      setTimeout: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const app = new KanaTuiApp(
      () =>
        ({
          state: {
            messages: [],
            model: {
              metadata: {
                provider: "test",
                model: "test-model",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1,
                maxOutputTokens: 1,
              },
            },
          },
          stream(input: unknown) {
            const stream = new AgentEventStream();
            calls.push({ input, stream });
            return stream;
          },
        }) as never,
      createTerminal(),
      {
        ...createOptions(),
        initialSession: { id: "session-a", messages: [], timeline: [] },
        wakeScheduler,
      },
    );
    const internal = app as unknown as { submitPrompt(value: string): Promise<void> };

    const prompt = internal.submitPrompt("Start the task.");
    expect(calls).toHaveLength(1);
    wakeScheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check the task.",
    });
    timers.get(1)?.();

    expect(calls).toHaveLength(1);
    calls[0]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    await prompt;
    await waitFor(() => calls.length === 2);

    expect(calls[1]?.input).toEqual({
      role: "user",
      content: "[Scheduled wake event]\nCheck the task.",
      source: "scheduled",
    });
    calls[1]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    wakeScheduler.dispose();
  });

  test("drains a wake queued during an auxiliary run when it becomes idle", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const calls: Array<{ input: unknown; stream: AgentEventStream }> = [];
    const wakeScheduler = createWakeScheduler({
      setTimeout: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const app = new KanaTuiApp(
      () =>
        ({
          state: {
            messages: [],
            model: {
              metadata: {
                provider: "test",
                model: "test-model",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1,
                maxOutputTokens: 1,
              },
            },
          },
          stream(input: unknown) {
            const stream = new AgentEventStream();
            calls.push({ input, stream });
            return stream;
          },
        }) as never,
      createTerminal(),
      {
        ...createOptions(),
        initialSession: { id: "session-a", messages: [], timeline: [] },
        wakeScheduler,
      },
    );
    const internal = app as unknown as {
      running: boolean;
      clearAuxiliaryRunStatus(): void;
    };

    internal.running = true;
    wakeScheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check the task.",
    });
    timers.get(1)?.();

    expect(calls).toHaveLength(0);
    internal.running = false;
    internal.clearAuxiliaryRunStatus();
    await waitFor(() => calls.length === 1);

    expect(calls[0]?.input).toMatchObject({ source: "scheduled" });
    calls[0]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    wakeScheduler.dispose();
  });

  test("replaces the temporary manual-compaction message with the persisted marker", async () => {
    let listener: ((event: never) => void) | undefined;
    let finishCompaction!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishCompaction = resolve;
    });
    const app = new KanaTuiApp(
      () =>
        ({
          ...(createAgentStub() as unknown as object),
          subscribe(next: (event: never) => void) {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          async compact() {
            listener?.({
              type: "context_compaction_start",
              reason: "manual",
              estimatedTokens: 60_800,
              contextLimit: 100_000,
            } as never);
            await finished;
            listener?.({
              type: "context_compacted",
              reason: "manual",
              beforeTokens: 60_800,
              estimatedAfterTokens: 14_800,
              compactedMessageCount: 20,
              contextLimit: 100_000,
            } as never);
            return {};
          },
        }) as never,
      createTerminal(),
      createOptions(),
    );
    const internal = app as unknown as {
      handleCommand(command: { name: "compact"; arguments: string; raw: string }): void;
      transcript: { render(width: number): string[] };
    };

    internal.handleCommand({ name: "compact", arguments: "", raw: "/compact" });

    expect(renderTranscript(internal.transcript)).toContain("Compacting context…");

    finishCompaction();
    await waitFor(() =>
      renderTranscript(internal.transcript).includes("Context compacted · 60.8k → ~14.8k tokens"),
    );

    const transcript = renderTranscript(internal.transcript);
    expect(transcript).not.toContain("Compacting context…");
    expect(transcript).toContain("Context compacted · 60.8k → ~14.8k tokens");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Condition was not met.");
}

function createOptions() {
  return {
    getResumeSessionId: () => undefined,
    createNewSession: () => ({ id: "new" }),
    forkSession: () => ({ id: "fork" }),
    listSessions: () => [],
    loadSession: () => ({ id: "session", messages: [], timeline: [] }),
    deleteSession: () => false,
    loadSkills: () => ({ skills: [], globalEnabledSkillNames: [], diagnostics: [] }),
    saveEnabledGlobalSkills: () => {},
    toolApproval: {
      config: { mode: "unless_trusted" as const },
      approvals: {
        version: 2 as const,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
    },
    notification: {} as never,
    compactMemory: async () => [],
    loadMemory: () => "",
    loadUsage: () => ({
      scope: "session" as const,
      runCount: 0,
      mainRunCount: 0,
      memoryRunCount: 0,
      costCny: 0,
      outcomes: {
        stop: 0,
        length: 0,
        aborted: 0,
        error: 0,
        turn_limit: 0,
        updated: 0,
        unchanged: 0,
      },
      agents: {
        main: { runCount: 0, costCny: 0 },
        memoryAutomatic: { runCount: 0, costCny: 0 },
        memoryManual: { runCount: 0, costCny: 0 },
      },
      models: [],
    }),
  };
}

function createTerminal(): Terminal {
  return {
    columns: 80,
    rows: 24,
    start: () => {},
    stop: () => {},
    write: () => {},
    notify: () => {},
  };
}

function createAgentStub() {
  return {
    state: {
      messages: [],
      model: {
        metadata: {
          provider: "test",
          model: "test-model",
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1,
          maxOutputTokens: 1,
        },
      },
    },
    abort() {},
    async waitForIdle() {},
  } as never;
}

function renderTranscript(transcript: { render(width: number): string[] }): string {
  return stripAnsi(transcript.render(80).join("\n"));
}
