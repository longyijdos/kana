import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import { KanaTuiApp } from "../../src/tui/app/app";
import { ToolCallBlock } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component } from "../../src/tui/runtime";
import {
  createTerminalStub as createTerminal,
  createTuiAgentStub,
  createTuiAppOptions,
} from "./app-fixture";

const CTRL_O = "\x0f";

const session: KanaSessionMetadata = {
  id: "session-1",
  createdAt: "2026-07-19T00:00:00.000Z",
  title: "Test session",
  cwd: "/repo",
  path: "/sessions/session-1.jsonl",
};

describe("global Ctrl+O", () => {
  test("opens the newest tool detail from the editor", () => {
    const harness = createHarness({ tools: ["bun test"] });

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(true);
    expect(harness.render()).toContain("bun test");
  });

  test("leaves the editor unchanged when the session has no tool call", () => {
    const harness = createHarness();
    const before = harness.render();

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(false);
    expect(harness.internal.tui.getFocus()).toBe(harness.internal.editor);
    expect(harness.render()).toBe(before);
  });

  test("neither closes nor replaces an open tool detail", () => {
    const harness = createHarness({ tools: ["bun test"] });

    harness.ctrlO();
    const viewer = harness.internal.tui.getFocus();

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(true);
    expect(harness.internal.tui.getFocus()).toBe(viewer);
  });

  test("keeps the tool detail until Esc closes it", () => {
    const harness = createHarness({ tools: ["bun test"] });

    harness.ctrlO();
    harness.press("\x1b");

    expect(harness.internal.contentViewer.active).toBe(false);
    expect(harness.internal.tui.getFocus()).toBe(harness.internal.editor);
  });

  test("leaves the resume picker open", () => {
    const harness = createHarness({ tools: ["bun test"], sessions: [session] });

    harness.command("resume");
    expect(harness.render()).toContain("Sessions");
    const picker = harness.internal.tui.getFocus();

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(false);
    expect(harness.internal.tui.getFocus()).toBe(picker);
    expect(harness.render()).toContain("Sessions");
  });

  test("leaves a delete confirmation open inside the resume picker", () => {
    const harness = createHarness({ tools: ["bun test"], sessions: [session] });

    harness.command("resume");
    harness.press("K");
    expect(harness.render()).toContain("Delete session?");
    const confirmation = harness.internal.tui.getFocus();

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(false);
    expect(harness.internal.tui.getFocus()).toBe(confirmation);
    expect(harness.render()).toContain("Delete session?");
  });

  test("leaves the tool history picker open", () => {
    const harness = createHarness({ tools: ["bun test"] });

    harness.command("tools");
    expect(harness.internal.toolHistory.active).toBe(true);
    const picker = harness.internal.tui.getFocus();

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(false);
    expect(harness.internal.tui.getFocus()).toBe(picker);
    expect(harness.render()).toContain("Tool history");
  });

  test("leaves the jobs manager open", () => {
    const harness = createHarness({ tools: ["bun test"] });

    harness.command("jobs");
    expect(harness.internal.backgroundJobManager.active).toBe(true);
    const manager = harness.internal.tui.getFocus();

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(false);
    expect(harness.internal.tui.getFocus()).toBe(manager);
    expect(harness.render()).toContain("Background Jobs");
  });

  test("leaves the agents manager open", () => {
    const harness = createHarness({ tools: ["bun test"] });

    harness.command("agents");
    expect(harness.internal.subagentManager.active).toBe(true);
    const manager = harness.internal.tui.getFocus();

    harness.ctrlO();

    expect(harness.internal.contentViewer.active).toBe(false);
    expect(harness.internal.tui.getFocus()).toBe(manager);
    expect(harness.render()).toContain("Agents · current session");
  });

  test("keeps the explicit /tools enter transition into tool detail", () => {
    const harness = createHarness({ tools: ["bun test"] });

    harness.command("tools");
    harness.press("\r");

    expect(harness.internal.toolHistory.active).toBe(false);
    expect(harness.internal.contentViewer.active).toBe(true);
    expect(harness.render()).not.toContain("Tool history");
    expect(harness.render()).toContain("bun test");
  });
});

function createHarness(options?: { tools?: string[]; sessions?: KanaSessionMetadata[] }) {
  const appOptions = createTuiAppOptions();
  const app = new KanaTuiApp(() => createTuiAgentStub(), createTerminal(), {
    ...appOptions,
    conversation: {
      ...appOptions.conversation,
      listSessions: () => options?.sessions ?? [],
    },
  });
  const internal = app as unknown as AppInternals;

  app.start();

  for (const [index, command] of (options?.tools ?? []).entries()) {
    const block = new ToolCallBlock({
      type: "tool_call",
      id: `call-${index + 1}`,
      name: "bash",
      args: { command },
    });
    block.updateResult({ command, exitCode: 0, stdout: "1 pass" }, false);
    internal.transcript.addChild(block);
  }

  return {
    internal,
    ctrlO: () => internal.handleGlobalInput(CTRL_O),
    press: (data: string) => internal.tui.getFocus()?.handleInput?.(data),
    command: (name: CommandName) =>
      internal.handleCommand({ name, arguments: "", raw: `/${name}` }),
    render: () => internal.layout.render(80, 24).map(stripAnsi).join("\n"),
  };
}

type CommandName = "resume" | "tools" | "jobs" | "agents";

type AppInternals = {
  editor: Component;
  transcript: { children: unknown[]; addChild: (child: unknown) => void };
  contentViewer: { active: boolean };
  toolHistory: { active: boolean };
  backgroundJobManager: { active: boolean };
  subagentManager: { active: boolean };
  handleGlobalInput: (data: string) => void;
  handleCommand: (command: { name: CommandName; arguments: string; raw: string }) => void;
  tui: { getFocus: () => Component | undefined };
  layout: { render: (width: number, availableHeight?: number) => string[] };
};
