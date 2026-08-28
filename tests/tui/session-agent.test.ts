import { describe, expect, test } from "bun:test";
import { AgentEventStream } from "../../src/agent";
import { createWakeScheduler, type KanaSessionMetadata } from "../../src/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Terminal } from "../../src/tui/runtime";
import { withAgentInboxForTest } from "../helpers/agent-inbox";
import { messageIdentityForTest } from "../helpers/messages";

describe("session-scoped agents", () => {
  test("resets a temporary tool approval mode when the session changes", async () => {
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

    await waitFor(() => internal.toolApproval.mode === "unless_trusted");
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
    const appOptions = createOptions();
    const app = new KanaTuiApp(() => createAgentStub(), createTerminal(), {
      ...appOptions,
      launch: { startInResumePicker: true },
      conversation: {
        ...appOptions.conversation,
        listSessions: () => [session],
        loadSession: () => ({ id: session.id, messages: [], timeline: [] }),
      },
      externalTools: {
        load: async () => {
          loadCount += 1;
          return {};
        },
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
    let forkCount = 0;
    const appOptions = createOptions();
    const app = new KanaTuiApp(() => createAgentStub(), createTerminal(), {
      ...appOptions,
      launch: { mode: "clean" },
      conversation: {
        ...appOptions.conversation,
        forkSession: () => {
          forkCount += 1;
          return { id: "fork" };
        },
      },
      externalTools: {
        load: async () => {
          externalToolLoadCount += 1;
          return {};
        },
      },
    });
    const internal = app as unknown as {
      handleCommand(command: {
        name: "skills" | "mcp" | "memory" | "fork" | "resume" | "delete";
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
    internal.handleCommand({ name: "fork", arguments: "Try another path.", raw: "/fork" });
    internal.handleCommand({ name: "resume", arguments: "saved-session", raw: "/resume" });
    internal.handleCommand({ name: "delete", arguments: "", raw: "/delete" });

    const transcript = renderTranscript(internal.transcript);
    expect(externalToolLoadCount).toBe(0);
    expect(forkCount).toBe(0);
    expect(transcript).toContain(
      "Clean mode · temporary session; customizations and saving are disabled.",
    );
    expect(transcript).toContain("Skills are unavailable in clean mode.");
    expect(transcript).toContain("MCP management is unavailable in clean mode.");
    expect(transcript).toContain("Memory is unavailable in clean mode.");
    expect(transcript).toContain("Forking sessions is unavailable in clean mode.");
    expect(transcript.match(/Saved sessions are unavailable in clean mode\./g)).toHaveLength(2);
    expect(stripAnsi(internal.layout.render(120).join("\n"))).toContain("clean");
  });

  test("holds due wakes while the schedule manager is open and drains them on close", async () => {
    const timers = new Map<number | ReturnType<typeof setTimeout>, () => void>();
    const calls: Array<{ input: unknown; stream: AgentEventStream }> = [];
    const wakeScheduler = createWakeScheduler({
      setTimeout: (callback) => {
        timers.set(1, callback);
        return 1;
      },
      clearTimeout: (timer) => timers.delete(timer),
    });
    const appOptions = createOptions();
    const app = new KanaTuiApp(
      () =>
        withAgentInboxForTest({
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
      },
    );
    const internal = app as unknown as {
      handleCommand(command: { name: "schedule"; arguments: string; raw: string }): void;
      tui: { getFocus(): Component | undefined };
    };

    internal.handleCommand({ name: "schedule", arguments: "", raw: "/schedule" });
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
    const appOptions = createOptions();
    const app = new KanaTuiApp(
      () =>
        withAgentInboxForTest({
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
      },
    );
    const internal = app as unknown as {
      status: { startRun(): void };
      finishAuxiliaryRun(): void;
    };

    internal.status.startRun();
    wakeScheduler.schedule({
      sessionId: "session-a",
      afterMinutes: 30,
      message: "Check the task.",
    });
    timers.get(1)?.();

    expect(calls).toHaveLength(0);
    internal.finishAuxiliaryRun();
    await waitFor(() => calls.length === 1);

    expect(calls[0]?.input).toMatchObject({
      provenance: { kind: "scheduled_input", origin: "agent" },
    });
    calls[0]?.stream.end({ type: "agent_end", reason: "stop", messages: [] });
    wakeScheduler.dispose();
  });

  test("updates approximate context from turn_end instead of raw response usage", async () => {
    const calls: AgentEventStream[] = [];
    const appOptions = createOptions();
    const app = new KanaTuiApp(
      () =>
        withAgentInboxForTest({
          state: {
            messages: [],
            estimatedContextTokens: 1_000,
            contextLimit: 100_000,
            model: {
              metadata: {
                provider: "test",
                model: "test-model",
                contextWindow: 100_000,
                maxOutputTokens: 1,
              },
            },
          },
          stream() {
            const stream = new AgentEventStream();
            calls.push(stream);
            return stream;
          },
        }) as never,
      createTerminal(),
      {
        ...appOptions,
        conversation: {
          ...appOptions.conversation,
          initialSession: { id: "session-a", messages: [], timeline: [] },
        },
      },
    );
    const internal = app as unknown as {
      submitPrompt(value: string): Promise<void>;
      layout: { render(width: number): string[] };
    };
    const message = {
      ...messageIdentityForTest("assistant"),
      role: "assistant" as const,
      stopReason: "stop" as const,
      usage: {
        promptTokens: 90_000,
        completionTokens: 100,
        totalTokens: 90_100,
      },
      content: [{ type: "text" as const, text: "Done" }],
    };

    const prompt = internal.submitPrompt("Start the task.");
    expect(calls).toHaveLength(1);
    calls[0]?.push({ type: "agent_start" });
    calls[0]?.push({ type: "turn_start", turn: 1 });
    calls[0]?.push({ type: "message_start", message });
    calls[0]?.push({ type: "message_end", message });
    calls[0]?.push({
      type: "turn_end",
      turn: 1,
      message,
      toolResults: [],
      estimatedContextTokens: 25_000,
    });

    await waitFor(() =>
      stripAnsi(internal.layout.render(100).join("\n")).includes("Context ~25% used"),
    );
    expect(stripAnsi(internal.layout.render(100).join("\n"))).not.toContain("Context ~90% used");

    calls[0]?.end({ type: "agent_end", reason: "stop", messages: [message] });
    await prompt;
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
    launch: {},
    conversation: {
      getResumeSessionId: () => undefined,
      createNewSession: () => ({ id: "new" }),
      forkSession: () => ({ id: "fork" }),
      listSessions: () => [],
      loadSession: () => ({ id: "session", messages: [], timeline: [] }),
      deleteSession: () => false,
      goalMaxRounds: 8,
    },
    skills: {
      load: () => ({ skills: [], globalEnabledSkillNames: [], diagnostics: [] }),
      saveEnabledGlobalNames: () => {},
    },
    toolApproval: {
      config: { mode: "unless_trusted" as const },
      approvals: {
        version: 2 as const,
        bash: { exactCommands: [], readOnlyCommands: [] },
      },
    },
    ui: { notification: {} as never },
    memory: { compact: async () => [], load: () => "" },
    usage: {
      load: () => ({
        scope: "session" as const,
        runCount: 0,
        mainRunCount: 0,
        memoryRunCount: 0,
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
          main: { runCount: 0 },
          memoryAutomatic: { runCount: 0 },
          memoryManual: { runCount: 0 },
        },
        models: [],
      }),
    },
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
  }) as never;
}

function renderTranscript(transcript: { render(width: number): string[] }): string {
  return stripAnsi(transcript.render(80).join("\n"));
}
