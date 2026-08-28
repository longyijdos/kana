import { describe, expect, test } from "bun:test";
import type { KanaTodoItem, KanaUsageScope, KanaUsageSummary } from "@/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { ToolCallBlock } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Terminal } from "../../src/tui/runtime";
import { withAgentInboxForTest } from "../helpers/agent-inbox";

describe("information viewers", () => {
  test("keeps Agent status while opening help during a run", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    startRun(internal, "tool");
    internal.handleCommand({ name: "help", arguments: "", raw: "/help" });

    expect(internal.contentViewer.active).toBe(true);
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Tool read");
  });

  test("routes escape through a running content viewer before aborting the Agent", () => {
    const { internal, sendInput, state } = createStartedApp();

    startRun(internal, "tool");
    internal.handleCommand({ name: "help", arguments: "", raw: "/help" });

    sendInput("\x1b");

    expect(internal.contentViewer.active).toBe(false);
    expect(state.abortCalls).toBe(0);
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Tool read");
  });

  test("keeps a running schedule flow focused on its own escape semantics", () => {
    const { internal, sendInput, state } = createStartedApp();

    startRun(internal, "responding");
    internal.handleCommand({ name: "schedule", arguments: "", raw: "/schedule" });

    sendInput("a");
    for (let index = 0; index < 4; index += 1) {
      sendInput("\x1b[B");
    }
    sendInput("\r");
    expect(internal.scheduledMessageManager.active).toBe(true);
    expect(internal.layout.render(80, 24).map(stripAnsi)).toContain("Custom delay (1m–24h)");

    sendInput("\x1b");
    expect(internal.scheduledMessageManager.active).toBe(true);
    expect(internal.layout.render(80, 24).map(stripAnsi)).toContain("Schedule after");
    expect(state.abortCalls).toBe(0);

    sendInput("\x1b");
    expect(internal.scheduledMessageManager.active).toBe(true);
    expect(internal.layout.render(80, 24).map(stripAnsi)).toContain(
      "Scheduled messages · process only",
    );
    expect(state.abortCalls).toBe(0);

    sendInput("\x1b");
    expect(internal.scheduledMessageManager.active).toBe(false);
    expect(state.abortCalls).toBe(0);
  });

  test("does nothing for escape in the idle editor", () => {
    const { internal, sendInput, state } = createStartedApp();

    sendInput("\x1b");

    expect(internal.tui.getFocus()).toBe(internal.editor);
    expect(state.abortCalls).toBe(0);
  });

  test("keeps Agent status when image attachment fails during a run", async () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    startRun(internal, "tool");
    internal.handleCommand({
      name: "image",
      arguments: "/missing/image.png",
      raw: "/image /missing/image.png",
    });
    await Promise.resolve();

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(rendered).toContain("Model test-model does not support image input.");
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Tool read");
  });

  test("keeps runtime run_error as a terminal Error status", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    startRun(internal, "responding");
    internal.handleConversationEvent({
      type: "run_error",
      source: "user",
      error: new Error("runtime failure"),
    });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(internal.status.running).toBe(false);
    expect(rendered).toContain("runtime failure");
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Error");
  });

  test("opens the current session todo state without adding transcript content", () => {
    const app = createApp(createUsageSummary, [
      { content: "Implement durable state", status: "in_progress" },
      { content: "Update documentation", status: "completed" },
    ]);
    const internal = app as unknown as AppInternals;

    internal.status.startRun();
    internal.handleCommand({ name: "todo", arguments: "", raw: "/todo" });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");
    expect(internal.transcript.children).toHaveLength(0);
    expect(internal.contentViewer.active).toBe(true);
    expect(rendered).toContain("Todos");
    expect(rendered).toContain("1 active · 0 pending · 1 completed");
    expect(rendered).toContain("◉ Implement durable state");
    expect(rendered).toContain("✓ Update documentation");
  });

  test("ctrl+o over an open tool history picker replaces it without stale state", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call-latest",
      name: "bash",
      args: { command: "bun test" },
    });
    block.updateResult({ command: "bun test", exitCode: 0, stdout: "1 pass" }, false);
    internal.transcript.addChild(block);

    internal.handleCommand({ name: "tools", arguments: "", raw: "/tools" });
    expect(internal.toolHistory.active).toBe(true);

    internal.handleGlobalInput("\x0f");

    expect(internal.toolHistory.active).toBe(false);
    expect(internal.contentViewer.active).toBe(true);
    const inspector = internal.layout.render(80, 24).map(stripAnsi).join("\n");
    expect(inspector).not.toContain("Tool history");
    expect(inspector).toContain("Command");
    expect(inspector).toContain("bun test");

    internal.tui.getFocus()?.handleInput?.("\x1b");

    expect(internal.contentViewer.active).toBe(false);
    expect(internal.toolHistory.active).toBe(false);
    expect(internal.layout.render(80, 24).some((line) => line.includes("test-model"))).toBe(true);
  });

  test("ctrl+o with no tools keeps an open tool history picker usable", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "tools", arguments: "", raw: "/tools" });
    expect(internal.toolHistory.active).toBe(true);

    internal.handleGlobalInput("\x0f");

    expect(internal.toolHistory.active).toBe(true);
    expect(internal.contentViewer.active).toBe(false);
    const rendered = internal.layout.render(80, 24).map(stripAnsi);
    expect(rendered).toContain("Tool history");
    expect(rendered).toContain("No tool calls in this session.");

    internal.tui.getFocus()?.handleInput?.("\x1b");
    expect(internal.toolHistory.active).toBe(false);
  });
});

type AppInternals = {
  editor: {
    render: (width: number) => string[];
  };
  status: {
    running: boolean;
    startRun: () => void;
    update: (phase: "responding" | "tool", extra?: { activeTool?: string }) => void;
  };
  handleCommand: (command: {
    name: "help" | "memory" | "todo" | "usage" | "tools" | "schedule" | "jobs" | "model" | "image";
    arguments: string;
    raw: string;
  }) => void;
  handleConversationEvent: (event: unknown) => void;
  handleGlobalInput: (data: string) => void;
  transcript: { children: unknown[]; addChild: (child: unknown) => void };
  contentViewer: { active: boolean };
  toolHistory: { active: boolean };
  scheduledMessageManager: { active: boolean };
  tui: { getFocus: () => Component | undefined };
  layout: { render: (width: number, availableHeight?: number) => string[] };
};

function startRun(internal: AppInternals, phase: "responding" | "tool"): void {
  internal.status.startRun();
  internal.status.update(phase, phase === "tool" ? { activeTool: "read" } : undefined);
}

function createApp(
  loadUsage: (scope: KanaUsageScope) => KanaUsageSummary = createUsageSummary,
  todoState?: KanaTodoItem[],
  onAbort?: () => void,
  captureInput?: (onInput: (data: string) => void) => void,
): KanaTuiApp {
  return new KanaTuiApp(
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
        ...(onAbort ? { abort: onAbort } : {}),
      }) as never,
    createTerminal(captureInput),
    {
      launch: {},
      conversation: {
        initialSession:
          todoState === undefined
            ? undefined
            : { id: "session", messages: [], timeline: [], todoState },
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
      toolApproval: { config: {}, approvals: {} } as never,
      ui: { notification: {} as never },
      memory: { compact: async () => [], load: () => "" },
      usage: { load: loadUsage },
    },
  );
}

function createStartedApp(): {
  app: KanaTuiApp;
  internal: AppInternals;
  sendInput: (data: string) => void;
  state: { abortCalls: number };
} {
  let sendInput!: (data: string) => void;
  const state = { abortCalls: 0 };
  const app = createApp(
    createUsageSummary,
    undefined,
    () => {
      state.abortCalls += 1;
    },
    (onInput) => {
      sendInput = onInput;
    },
  );
  app.start();

  return {
    app,
    internal: app as unknown as AppInternals,
    sendInput,
    state,
  };
}

function createUsageSummary(scope: KanaUsageScope): KanaUsageSummary {
  return {
    scope,
    runCount: 1,
    mainRunCount: 1,
    memoryRunCount: 0,
    usage: {
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
      promptCacheHitTokens: 20,
      promptCacheMissTokens: 10,
    },
    outcomes: {
      stop: 1,
      length: 0,
      aborted: 0,
      error: 0,
      turn_limit: 0,
      updated: 0,
      unchanged: 0,
    },
    agents: {
      main: {
        runCount: 1,
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
      },
      memoryAutomatic: { runCount: 0 },
      memoryManual: { runCount: 0 },
    },
    models: [],
  };
}

function createTerminal(captureInput?: (onInput: (data: string) => void) => void): Terminal {
  return {
    columns: 80,
    rows: 24,
    start: (onInput) => captureInput?.(onInput),
    stop: () => {},
    write: () => {},
    notify: () => {},
  };
}
