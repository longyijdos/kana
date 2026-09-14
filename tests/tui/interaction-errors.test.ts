import { describe, expect, test } from "bun:test";
import { KanaTuiApp } from "../../src/tui/app/app";
import { InteractionErrorReporter } from "../../src/tui/app/interaction-error-reporter";
import type { StatusProjectionController } from "../../src/tui/app/status-projection-controller";
import { Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import {
  createTerminalStub as createTerminal,
  createTuiAgentStub,
  createTuiAppOptions,
} from "./app-fixture";

describe("interaction error reporting", () => {
  test("adds interaction errors to the transcript without touching the run phase", () => {
    const transcript = new Transcript();
    const phases: string[] = [];
    const reporter = new InteractionErrorReporter({
      transcript,
      status: createStatusStub(phases),
    });

    reporter.showInteractionError(new Error("Usage: /fork <prompt>"));

    expect(stripAnsi(transcript.render(120).join("\n"))).toContain("Usage: /fork <prompt>");
    expect(phases).toEqual([]);
  });

  test("marks the run phase for run errors", () => {
    const transcript = new Transcript();
    const phases: string[] = [];
    const reporter = new InteractionErrorReporter({
      transcript,
      status: createStatusStub(phases),
    });

    reporter.showRunError(new Error("runtime failure"));

    expect(stripAnsi(transcript.render(120).join("\n"))).toContain("runtime failure");
    expect(phases).toEqual(["error"]);
  });

  test("keeps the idle phase when a clean-mode command is unavailable", () => {
    const internal = createStartedApp({ mode: "clean" });

    internal.handleCommand({ name: "skills", arguments: "", raw: "/skills" });

    expect(renderTranscript(internal)).toContain("Skills are unavailable in clean mode.");
    expect(renderStatusLine(internal)).toContain("Idle");
    expect(renderStatusLine(internal)).not.toContain("Error");
  });

  test("keeps the idle phase for slash command usage errors", () => {
    const internal = createStartedApp();

    internal.handleCommand({ name: "fork", arguments: "", raw: "/fork" });

    expect(renderTranscript(internal)).toContain("Usage: /fork <prompt>");
    expect(renderStatusLine(internal)).toContain("Idle");
    expect(renderStatusLine(internal)).not.toContain("Error");
  });
});

type AppInternals = {
  editor: { render: (width: number) => string[] };
  transcript: { render: (width: number) => string[] };
  handleCommand: (command: { name: "skills" | "fork"; arguments: string; raw: string }) => void;
};

function createStatusStub(phases: string[]): StatusProjectionController {
  return {
    update: (phase: string) => phases.push(phase),
  } as unknown as StatusProjectionController;
}

function createStartedApp(launch: { mode?: "clean" } = {}): AppInternals {
  const options = createTuiAppOptions();
  const app = new KanaTuiApp(() => createTuiAgentStub(), createTerminal(), {
    ...options,
    launch,
  });

  app.start();

  return app as unknown as AppInternals;
}

function renderTranscript(internal: AppInternals): string {
  return stripAnsi(internal.transcript.render(120).join("\n"));
}

function renderStatusLine(internal: AppInternals): string {
  return stripAnsi(internal.editor.render(120).at(-1) ?? "");
}
