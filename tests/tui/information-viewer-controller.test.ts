import { describe, expect, test } from "bun:test";
import type { KanaUsageScope, KanaUsageSummary } from "@/kana";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { ContentViewerController } from "../../src/tui/app/content-viewer-controller";
import { InformationViewerController } from "../../src/tui/app/information-viewer-controller";
import { StatusProjectionController } from "../../src/tui/app/status-projection-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("information viewer controller", () => {
  test("opens command help without adding transcript content", () => {
    const harness = createHarness();
    harness.editor.setText("draft");

    harness.controller.openHelp();

    expect(harness.transcript.children).toHaveLength(0);
    expect(harness.contentViewer.active).toBe(true);
    expect(harness.editor.getText()).toBe("");
    expect(harness.render()).toContain("Slash commands");
    expect(harness.render().some((line) => line.includes("/fork <prompt>"))).toBe(true);
  });

  test("loads the selected usage scope into the content viewer", () => {
    const harness = createHarness();

    harness.controller.openUsage("project");

    expect(harness.usageScopes).toEqual(["project"]);
    expect(harness.contentViewer.active).toBe(true);
    expect(harness.render()).toContain("Usage · project");
  });

  test("rejects session usage in clean mode before loading data", () => {
    const harness = createHarness(true);

    harness.controller.openUsage("session");

    expect(harness.usageScopes).toEqual([]);
    expect(harness.contentViewer.active).toBe(false);
    expect(harness.errors).toEqual(["Session usage is unavailable in clean mode."]);
  });

  test("combines requested memory scopes in one Markdown viewer", () => {
    const harness = createHarness();

    harness.controller.openMemory("both");

    expect(harness.memoryTargets).toEqual(["global", "project"]);
    const rendered = harness.render().join("\n");
    expect(rendered).toContain("Global memory");
    expect(rendered).toContain("Project memory");
    expect(rendered).toContain("global notes");
    expect(rendered).toContain("project notes");
  });

  test("wraps Markdown memory content without truncating it", () => {
    const memory = "This memory entry must remain fully visible after wrapping.";
    const harness = createHarness(false, memory);

    harness.controller.openMemory("global");

    const renderedMemory = harness
      .render(20)
      .filter((line) => line.startsWith("  "))
      .map((line) => line.slice(2))
      .join("");
    expect(renderedMemory).toContain(memory);
  });

  test("opens the supplied current todo projection", () => {
    const harness = createHarness();

    harness.controller.openTodos();

    expect(harness.contentViewer.active).toBe(true);
    expect(harness.render()).toContain("Todos");
    expect(harness.render().join("\n")).toContain("1 active · 1 completed");
  });
});

function createHarness(cleanMode = false, memoryContent?: string) {
  const editor = new Editor({ model: "test-model" });
  const transcript = new Transcript();
  const tui = createTuiStub();
  const layout = new AppLayout({ main: transcript, bottom: editor });
  const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
  const contentViewer = new ContentViewerController({ bottomArea, transcript });
  const usageScopes: KanaUsageScope[] = [];
  const memoryTargets: string[] = [];
  const errors: string[] = [];
  const status = new StatusProjectionController({
    editor,
    getAgentState: () =>
      ({
        model: { metadata: { contextWindow: 100_000 } },
      }) as never,
  });
  const controller = new InformationViewerController({
    editor,
    contentViewer,
    status,
    cleanMode,
    hyperlinks: false,
    renderLatex: false,
    renderMermaid: false,
    loadMemory: (target) => {
      memoryTargets.push(target);
      return memoryContent ?? `${target} notes`;
    },
    loadUsage: (scope) => {
      usageScopes.push(scope);
      return createUsageSummary(scope);
    },
    renderTodos: () => ["1 active · 1 completed"],
    showError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  return {
    contentViewer,
    controller,
    editor,
    errors,
    memoryTargets,
    transcript,
    usageScopes,
    render: (width = 100) => layout.render(width, 40).map(stripAnsi),
  };
}

function createUsageSummary(scope: KanaUsageScope): KanaUsageSummary {
  return {
    scope,
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
  };
}

function createTuiStub(): Tui {
  let focusedComponent: Component | undefined;

  return {
    requestRender() {},
    getFocus: () => focusedComponent,
    setFocus: (component: Component | undefined) => {
      focusedComponent = component;
    },
  } as unknown as Tui;
}
