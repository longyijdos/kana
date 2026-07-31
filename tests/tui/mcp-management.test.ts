import { describe, expect, test } from "bun:test";
import { AgentEventStream } from "../../src/agent";
import { createWakeScheduler } from "../../src/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Terminal } from "../../src/tui/runtime";

describe("TUI MCP management", () => {
  test("applies one draft and rebuilds the Agent after reload", async () => {
    let reportProgress!: (status: string) => void;
    let resolveReload!: (result: { status: string; warnings: string[] }) => void;
    const reloadResult = new Promise<{ status: string; warnings: string[] }>((resolve) => {
      resolveReload = resolve;
    });
    const saved: string[][] = [];
    let toolsReady = false;
    const agentToolStates: boolean[] = [];
    const app = new KanaTuiApp(
      () => {
        agentToolStates.push(toolsReady);
        return createAgentStub() as never;
      },
      createTerminal(),
      {
        ...createOptions(),
        mcpManagement: {
          loadServers: () => [
            { id: "filesystem", type: "stdio", command: "npx", args: ["-y"], enabled: false },
          ],
          saveEnabledServerIds: (serverIds) => saved.push(serverIds),
          reloadExternalTools: (onProgress) => {
            reportProgress = onProgress;
            return reloadResult;
          },
        },
      },
    );
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "mcp", arguments: "", raw: "/mcp" });
    internal.tui.getFocus()?.handleInput?.("\r");

    expect(saved).toEqual([]);
    expect(agentToolStates).toEqual([false]);

    internal.tui.getFocus()?.handleInput?.("\x1b");

    expect(saved).toEqual([["filesystem"]]);
    expect(internal.tui.getFocus()).toBeUndefined();
    expect(renderTranscript(internal.transcript)).toContain("Reloading MCP servers...");

    reportProgress("Starting MCP servers... 0/1");
    expect(renderTranscript(internal.transcript)).toContain("Starting MCP servers... 0/1");

    toolsReady = true;
    resolveReload({
      status: "MCP reload complete: 1/1 servers ready · 2 tools",
      warnings: ["MCP server optional failed to start: unavailable"],
    });
    await waitFor(() => agentToolStates.length === 2);

    expect(agentToolStates).toEqual([false, true]);
    expect(renderTranscript(internal.transcript)).toContain(
      "MCP reload complete: 1/1 servers ready · 2 tools",
    );
    expect(renderTranscript(internal.transcript)).toContain(
      "MCP server optional failed to start: unavailable",
    );
    expect(internal.tui.getFocus()).toBe(internal.editor);
  });

  test("recovers the editor with a rebuilt Agent after reload fails", async () => {
    const agentToolStates: boolean[] = [];
    const app = new KanaTuiApp(
      () => {
        agentToolStates.push(false);
        return createAgentStub() as never;
      },
      createTerminal(),
      {
        ...createOptions(),
        mcpManagement: {
          loadServers: () => [
            {
              id: "required",
              type: "stdio",
              command: "required-mcp",
              args: [],
              enabled: false,
            },
          ],
          saveEnabledServerIds: () => {},
          reloadExternalTools: async () => {
            throw new Error("Required MCP servers failed to start: required.");
          },
        },
      },
    );
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "mcp", arguments: "", raw: "/mcp" });
    internal.tui.getFocus()?.handleInput?.("\r");
    internal.tui.getFocus()?.handleInput?.("\x1b");
    await waitFor(() => agentToolStates.length === 2);

    expect(renderTranscript(internal.transcript)).toContain(
      "Failed to reload MCP servers: Required MCP servers failed to start: required.",
    );
    expect(internal.tui.getFocus()).toBe(internal.editor);

    internal.handleCommand({ name: "mcp", arguments: "", raw: "/mcp" });
    expect(stripAnsi(internal.layout.render(80).join("\n"))).toContain("MCP servers");
  });

  test("queues scheduled wakes while the MCP manager is open", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const wakeScheduler = createWakeScheduler({
      setTimeout: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const calls: Array<{
      input: unknown;
      stream: AgentEventStream;
    }> = [];
    const app = new KanaTuiApp(
      () =>
        ({
          ...createAgentStub(),
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
        mcpManagement: {
          loadServers: () => [],
          saveEnabledServerIds: () => {},
          reloadExternalTools: async () => ({}),
        },
      },
    );
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "mcp", arguments: "", raw: "/mcp" });
    wakeScheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check the task.",
    });
    timers.get(1)?.();
    expect(calls).toEqual([]);

    internal.tui.getFocus()?.handleInput?.("\x1b");
    await waitFor(() => calls.length === 1);

    expect(calls[0]?.input).toMatchObject({ source: "scheduled" });
    calls[0]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    wakeScheduler.dispose();
  });
});

type AppInternals = {
  handleCommand(command: { name: "mcp"; arguments: string; raw: string }): void;
  transcript: { render(width: number): string[] };
  editor: Component;
  tui: { getFocus(): Component | undefined };
  layout: { render(width: number): string[] };
};

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
    toolApproval: { config: {}, approvals: {} } as never,
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

function renderTranscript(transcript: { render(width: number): string[] }): string {
  return stripAnsi(transcript.render(80).join("\n"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Condition was not met.");
}
