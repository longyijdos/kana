import { describe, expect, test } from "bun:test";
import type { KanaUsageScope, KanaUsageSummary } from "@/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { color, stripAnsi } from "../../src/tui/render";
import type { Component, Terminal } from "../../src/tui/runtime";
import { tuiTheme } from "../../src/tui/theme";

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
      rendered.some((line) => line.includes("/help") && line.includes("Show slash commands")),
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
      scrolled.some((line) => line.includes("Ctrl+O") && line.includes("expandable tool output")),
    ).toBe(true);
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

  test("cancels the usage scope prompt with escape", () => {
    const app = createApp();
    const internal = app as unknown as AppInternals;

    internal.handleCommand({ name: "usage", arguments: "", raw: "/usage" });
    internal.tui.getFocus()?.handleInput?.("\x1b");

    const rendered = internal.layout.render(80, 24).map(stripAnsi);

    expect(internal.slashCommandOptions.active).toBe(false);
    expect(rendered.some((line) => line.includes("test-model"))).toBe(true);
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
  handleCommand: (command: {
    name: "help" | "memory" | "usage";
    arguments: string;
    raw: string;
  }) => void;
  transcript: { children: unknown[] };
  contentViewer: { active: boolean };
  slashCommandOptions: { active: boolean };
  tui: { getFocus: () => Component | undefined };
  layout: { render: (width: number, availableHeight?: number) => string[] };
};

function createApp(
  loadUsage: (scope: KanaUsageScope) => KanaUsageSummary = createUsageSummary,
): KanaTuiApp {
  return new KanaTuiApp(
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
      }) as never,
    createTerminal(),
    {
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
    costCny: 1.25,
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
      main: { runCount: 1, costCny: 1.25 },
      memoryAutomatic: { runCount: 0, costCny: 0 },
      memoryManual: { runCount: 0, costCny: 0 },
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
