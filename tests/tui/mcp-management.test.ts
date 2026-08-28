import { describe, expect, test } from "bun:test";
import { AgentEventStream } from "../../src/agent";
import { createWakeScheduler } from "../../src/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { stripAnsi } from "../../src/tui/render";
import type { Component } from "../../src/tui/runtime";
import { withAgentInboxForTest } from "../helpers/agent-inbox";
import {
  createTuiAppOptions as createOptions,
  createTerminalStub as createTerminal,
} from "./app-fixture";

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
        externalTools: {
          mcp: {
            loadServers: () => [
              { id: "filesystem", type: "stdio", command: "npx", args: ["-y"], enabled: false },
            ],
            saveEnabledServerIds: (serverIds) => saved.push(serverIds),
            reload: (onProgress) => {
              reportProgress = onProgress;
              return reloadResult;
            },
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

    reportProgress("[1/1] MCP server filesystem ready · 2 tools.");
    expect(renderTranscript(internal.transcript)).toContain(
      "[1/1] MCP server filesystem ready · 2 tools.",
    );

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
        externalTools: {
          mcp: {
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
            reload: async () => {
              throw new Error("Required MCP servers failed to start: required.");
            },
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
    const appOptions = createOptions();
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
        ...appOptions,
        conversation: {
          ...appOptions.conversation,
          initialSession: { id: "session-a", messages: [], timeline: [] },
          wakeScheduler,
        },
        externalTools: {
          mcp: {
            loadServers: () => [],
            saveEnabledServerIds: () => {},
            reload: async () => ({}),
          },
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

    expect(calls[0]?.input).toMatchObject({
      provenance: { kind: "scheduled_input", origin: "agent" },
    });
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

function createAgentStub() {
  return withAgentInboxForTest({
    state: {
      messages: [],
      model: {
        metadata: {
          provider: "test",
          model: "test-model",
          contextWindow: 1,
          maxOutputTokens: 1,
        },
      },
    },
    abort() {},
    async waitForIdle() {},
  });
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
