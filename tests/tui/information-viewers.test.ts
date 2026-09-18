import { describe, expect, test } from "bun:test";
import type { KanaTodoItem, KanaUsageScope, KanaUsageSummary } from "@/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { stripAnsi } from "../../src/tui/render";
import type { Component } from "../../src/tui/runtime";
import { withAgentInboxForTest } from "../helpers/agent-inbox";
import { createTerminalStub as createTerminal, createTuiAppOptions } from "./app-fixture";

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
  transcript: { children: unknown[]; addChild: (child: unknown) => void };
  contentViewer: { active: boolean };
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
  const options = createTuiAppOptions();
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
      ...options,
      conversation: {
        ...options.conversation,
        initialSession:
          todoState === undefined
            ? undefined
            : { id: "session", messages: [], timeline: [], todoState },
      },
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
    subagentRunCount: 0,
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
      subagent: { runCount: 0 },
      memoryAutomatic: { runCount: 0 },
      memoryManual: { runCount: 0 },
    },
    models: [],
  };
}
