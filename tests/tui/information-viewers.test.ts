import { describe, expect, test } from "bun:test";
import type { KanaLaunchMode, KanaTodoItem, KanaUsageScope, KanaUsageSummary } from "@/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { ToolCallBlock } from "../../src/tui/components";
import { color, stripAnsi } from "../../src/tui/render";
import type { Component, Terminal } from "../../src/tui/runtime";
import { tuiTheme } from "../../src/tui/theme";
import { withAgentInboxForTest } from "../helpers/agent-inbox";

describe("information viewers", () => {
  test("opens help in the bottom viewer without adding transcript content", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "help", arguments: "", raw: "/help" });

    const rawRendered = internal.layout.render(80, 24);
    const rendered = rawRendered.map(stripAnsi);

    expect(internal.transcript.children).toHaveLength(0);
    expect(internal.contentViewer.active).toBe(true);
    expect(rendered).toContain("Slash commands");
    expect(rawRendered).toContain(color("Slash commands", tuiTheme.bottomTitle));
    expect(
      rendered.some(
        (line) => line.includes("/help") && line.includes("Show commands and shortcuts"),
      ),
    ).toBe(true);
    expect(
      rendered.some(
        (line) => line.includes("/fork <prompt>") && line.includes("Fork the current session"),
      ),
    ).toBe(true);
    expect(rendered).not.toContain("test-model");

    internal.tui.getFocus()?.handleInput?.("\x1b[F");
    const scrolled = internal.layout.render(80, 24).map(stripAnsi);

    expect(
      scrolled.some(
        (line) => line.includes("[ / ]") && line.includes("previous or next tool call"),
      ),
    ).toBe(true);
    expect(
      scrolled.some(
        (line) => line.includes("!<command>") && line.includes("Run a local bash command"),
      ),
    ).toBe(true);
  });

  test("keeps Agent status while opening help during a run", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.editor.updateStatus({ phase: "tool", running: true, activeTool: "read" });
    internal.handleCommand({ name: "help", arguments: "", raw: "/help" });

    expect(internal.contentViewer.active).toBe(true);
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Tool read");
  });

  test("shows running-unavailable errors without replacing Agent status", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.editor.updateStatus({ phase: "tool", running: true, activeTool: "read" });
    internal.handleCommand({ name: "model", arguments: "", raw: "/model" });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(rendered).toContain("/model is unavailable while Agent is running.");
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Tool read");
  });

  test("rejects usage arguments from the editor", () => {
    const loadedScopes: KanaUsageScope[] = [];
    const app = createApp((scope) => {
      loadedScopes.push(scope);
      return createUsageSummary(scope);
    });
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "usage", arguments: "global", raw: "/usage global" });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(loadedScopes).toEqual([]);
    expect(internal.transcript.children).toHaveLength(1);
    expect(internal.contentViewer.active).toBe(false);
    expect(internal.slashCommandOptions.active).toBe(false);
    expect(rendered).toContain("Usage: /usage");
  });

  test("selects a usage scope from the bottom prompt", () => {
    const loadedScopes: KanaUsageScope[] = [];
    const app = createApp((scope) => {
      loadedScopes.push(scope);
      return createUsageSummary(scope);
    });
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "usage", arguments: "", raw: "/usage" });

    const prompt = internal.layout.render(80, 24).map(stripAnsi);

    expect(internal.transcript.children).toHaveLength(0);
    expect(internal.slashCommandOptions.active).toBe(true);
    expect(internal.contentViewer.active).toBe(false);
    expect(prompt).toContain("Usage scope");
    expect(prompt).toContain("> Session");
    expect(prompt).toContain("  Project");
    expect(prompt).toContain("  Global");

    internal.tui.getFocus()?.handleInput?.("\x1b[B");
    internal.tui.getFocus()?.handleInput?.("\r");

    const viewer = internal.layout.render(80, 24).map(stripAnsi);

    expect(loadedScopes).toEqual(["project"]);
    expect(internal.slashCommandOptions.active).toBe(false);
    expect(internal.contentViewer.active).toBe(true);
    expect(viewer).toContain("Usage · project");
  });

  test("keeps Agent status when image attachment fails during a run", async () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.editor.updateStatus({ phase: "tool", running: true, activeTool: "read" });
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

  test("keeps Agent status while opening usage during a run", () => {
    const loadedScopes: KanaUsageScope[] = [];
    const app = createApp((scope) => {
      loadedScopes.push(scope);
      return createUsageSummary(scope);
    });
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.editor.updateStatus({ phase: "responding", running: true });
    internal.handleCommand({ name: "usage", arguments: "", raw: "/usage" });
    internal.tui.getFocus()?.handleInput?.("\r");

    expect(loadedScopes).toEqual(["session"]);
    expect(internal.contentViewer.active).toBe(true);
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Responding");
  });

  test("keeps runtime run_error as a terminal Error status", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.editor.updateStatus({ phase: "responding", running: true });
    internal.handleConversationEvent({
      type: "run_error",
      source: "user",
      error: new Error("runtime failure"),
    });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(internal.running).toBe(false);
    expect(rendered).toContain("runtime failure");
    expect(stripAnsi(internal.editor.render(80).join("\n"))).toContain("Error");
  });

  test("cancels the usage scope prompt with escape", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "usage", arguments: "", raw: "/usage" });
    internal.tui.getFocus()?.handleInput?.("\x1b");

    const rendered = internal.layout.render(80, 24).map(stripAnsi);

    expect(internal.slashCommandOptions.active).toBe(false);
    expect(rendered.some((line) => line.includes("test-model"))).toBe(true);
  });

  test("reports session usage as unavailable in clean mode", () => {
    const loadedScopes: KanaUsageScope[] = [];
    const app = createApp((scope) => {
      loadedScopes.push(scope);
      return createUsageSummary(scope);
    }, "clean");
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "usage", arguments: "", raw: "/usage" });
    internal.tui.getFocus()?.handleInput?.("\r");

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(loadedScopes).toEqual([]);
    expect(internal.slashCommandOptions.active).toBe(false);
    expect(internal.contentViewer.active).toBe(false);
    expect(rendered).toContain("Session usage is unavailable in clean mode.");
  });

  test("opens the tool history picker with an empty session state while running", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.handleCommand({ name: "tools", arguments: "", raw: "/tools" });

    const rendered = internal.layout.render(80, 24).map(stripAnsi);

    expect(internal.transcript.children).toHaveLength(0);
    expect(internal.toolHistory.active).toBe(true);
    expect(internal.contentViewer.active).toBe(false);
    expect(rendered).toContain("Tool history");
    expect(rendered).toContain("No tool calls in this session.");

    internal.tui.getFocus()?.handleInput?.("\x1b");

    expect(internal.toolHistory.active).toBe(false);
    expect(internal.layout.render(80, 24).some((line) => line.includes("test-model"))).toBe(true);
  });

  test("rejects tool history arguments from the editor", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "tools", arguments: "something", raw: "/tools something" });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(internal.toolHistory.active).toBe(false);
    expect(internal.contentViewer.active).toBe(false);
    expect(internal.transcript.children).toHaveLength(1);
    expect(rendered).toContain("Usage: /tools");
  });

  test("opens the scheduled message manager while running", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.handleCommand({ name: "schedule", arguments: "", raw: "/schedule" });

    expect(internal.scheduledMessageManager.active).toBe(true);
    expect(internal.layout.render(80, 24).map(stripAnsi)).toContain(
      "Scheduled messages · process only",
    );

    internal.tui.getFocus()?.handleInput?.("\x1b");
    expect(internal.scheduledMessageManager.active).toBe(false);
  });

  test("opens the current session todo state without adding transcript content", () => {
    const app = createApp(createUsageSummary, undefined, [
      { content: "Implement durable state", status: "in_progress" },
      { content: "Update documentation", status: "completed" },
    ]);
    const internal = app as unknown as AppInternals;

    internal.running = true;
    internal.handleCommand({ name: "todo", arguments: "", raw: "/todo" });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");
    expect(internal.transcript.children).toHaveLength(0);
    expect(internal.contentViewer.active).toBe(true);
    expect(rendered).toContain("Todos");
    expect(rendered).toContain("1 active · 0 pending · 1 completed");
    expect(rendered).toContain("◉ Implement durable state");
    expect(rendered).toContain("✓ Update documentation");
  });

  test("opens a tool picked from /tools in the same detail inspector", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;
    const block = new ToolCallBlock({
      type: "tool_call",
      id: "call-1",
      name: "bash",
      args: { command: "bun test" },
    });
    block.updateResult({ command: "bun test", exitCode: 0, stdout: "1 pass" }, false);
    internal.transcript.addChild(block);

    internal.handleCommand({ name: "tools", arguments: "", raw: "/tools" });

    const picker = internal.layout.render(80, 24).map(stripAnsi);
    expect(picker).toContain("Tool history");
    expect(picker).toContain("> Bash  bun test");

    internal.tui.getFocus()?.handleInput?.("\r");

    const inspector = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(internal.toolHistory.active).toBe(false);
    expect(internal.contentViewer.active).toBe(true);
    expect(inspector).toContain("Bash");
    expect(inspector).toContain("Command");
    expect(inspector).toContain("bun test");
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

  test("opens memory actions in the bottom prompt", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "memory", arguments: "", raw: "/memory" });

    const rendered = internal.layout.render(80, 24).map(stripAnsi);

    expect(internal.transcript.children).toHaveLength(0);
    expect(internal.slashCommandOptions.active).toBe(true);
    expect(rendered).toContain("Memory action");
    expect(rendered).toContain("> Show");
    expect(rendered).toContain("  Compact");
  });

  test("rejects memory arguments from the editor", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.handleCommand({
      name: "memory",
      arguments: "show project",
      raw: "/memory show project",
    });

    const rendered = internal.layout.render(80, 24).map(stripAnsi).join("\n");

    expect(internal.transcript.children).toHaveLength(1);
    expect(internal.contentViewer.active).toBe(false);
    expect(internal.slashCommandOptions.active).toBe(false);
    expect(rendered).toContain("Usage: /memory");
  });
});

type AppInternals = {
  running: boolean;
  editor: {
    render: (width: number) => string[];
    updateStatus: (state: { phase: string; running: boolean; activeTool?: string }) => void;
  };
  handleCommand: (command: {
    name: "help" | "memory" | "todo" | "usage" | "tools" | "schedule" | "model" | "image";
    arguments: string;
    raw: string;
  }) => void;
  handleConversationEvent: (event: unknown) => void;
  handleGlobalInput: (data: string) => void;
  transcript: { children: unknown[]; addChild: (child: unknown) => void };
  contentViewer: { active: boolean };
  slashCommandOptions: { active: boolean };
  toolHistory: { active: boolean };
  scheduledMessageManager: { active: boolean };
  tui: { getFocus: () => Component | undefined };
  layout: { render: (width: number, availableHeight?: number) => string[] };
};

function createApp(
  loadUsage: (scope: KanaUsageScope) => KanaUsageSummary = createUsageSummary,
  launchMode?: KanaLaunchMode,
  todoState?: KanaTodoItem[],
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
      }) as never,
    createTerminal(),
    {
      launchMode,
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
      loadSkills: () => ({ skills: [], globalEnabledSkillNames: [], diagnostics: [] }),
      saveEnabledGlobalSkills: () => {},
      toolApproval: { config: {}, approvals: {} } as never,
      notification: {} as never,
      compactMemory: async () => [],
      loadMemory: () => "",
      loadUsage,
    },
  );
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
