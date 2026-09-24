import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { SessionOverlayController } from "../../src/tui/app/session-overlay-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

const HELP_LINE = "Enter resume · ↑/↓ select · ←/→ page · K delete · Esc close";

const session: KanaSessionMetadata = {
  id: "session-1",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  title: "Test session",
  cwd: "/repo",
  path: "/sessions/session-1.jsonl",
};

const secondSession: KanaSessionMetadata = {
  id: "session-2",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  title: "Second session",
  cwd: "/repo",
  path: "/sessions/session-2.jsonl",
};

describe("session overlay controller", () => {
  test("replaces the editor with the picker and restores it after cancel", () => {
    const harness = createHarness({ sessions: [session] });

    harness.controller.openResume();

    expect(harness.render()).toContain("Sessions");
    expect(harness.render()).toContain(HELP_LINE);
    expect(harness.render()).not.toContain("test-model");

    harness.press("\x1b");

    expect(harness.render()).toContain("test-model");
    expect(harness.render()).not.toContain("Sessions");
    expect(harness.tui.getFocus()).toBe(harness.editor);
  });

  test("resumes the selected session with enter", () => {
    const harness = createHarness({ sessions: [session, secondSession] });

    harness.controller.openResume();
    harness.press("\x1b[B");
    harness.press("\r");

    expect(harness.events).toEqual(["resume:session-2"]);
    expect(harness.render()).toContain("test-model");
  });

  test("opens the delete confirmation with k instead of resuming", () => {
    const harness = createHarness({ sessions: [session], deleteSession: () => true });

    harness.controller.openResume();
    harness.press("K");

    expect(harness.focused()).toContain("Delete session?");
    expect(harness.render()).not.toContain("Sessions");
    expect(harness.events).toEqual([]);
  });

  test("returns to the picker with the previous selection after cancelling the confirmation", () => {
    const harness = createHarness({
      sessions: [session, secondSession],
      deleteSession: () => true,
    });

    harness.controller.openResume();
    harness.press("\x1b[B");
    harness.press("k");

    expect(harness.focused()).toContain("Delete session?");

    harness.press("\x1b");

    expect(harness.focused()).toContain("Sessions");
    expect(selectedLine(harness.focused())).toContain("Second session");
    expect(harness.events).toEqual([]);
  });

  test("refreshes the picker and keeps it open after a successful deletion", async () => {
    const sessions = [session, secondSession];
    const harness = createHarness({
      sessions,
      deleteSession: (sessionId) => {
        const index = sessions.findIndex((candidate) => candidate.id === sessionId);
        if (index >= 0) {
          sessions.splice(index, 1);
        }
        return true;
      },
    });

    harness.controller.openResume();
    harness.press("K");
    harness.press("\x1b[B");
    harness.press("\r");
    await flush();

    const picker = harness.focused();

    expect(picker).toContain("Sessions");
    expect(picker).toContain(HELP_LINE);
    expect(picker).not.toContain("Test session");
    expect(selectedLine(picker)).toContain("Second session");
    expect(stripAnsi(harness.transcript.render(80).join("\n"))).toContain(
      "Deleted session Test session.",
    );
    expect(harness.events).toEqual(["status:idle"]);
  });

  test("keeps the empty picker open after deleting the last session", async () => {
    const sessions = [session];
    const harness = createHarness({
      sessions,
      deleteSession: (sessionId) => {
        const index = sessions.findIndex((candidate) => candidate.id === sessionId);
        if (index >= 0) {
          sessions.splice(index, 1);
        }
        return true;
      },
    });

    harness.controller.openResume();
    harness.press("K");
    harness.press("\x1b[B");
    harness.press("\r");
    await flush();

    expect(harness.focused()).toContain("Sessions");
    expect(harness.focused()).toContain("No saved sessions for this workspace.");
    expect(harness.focused()).toContain(HELP_LINE);
    expect(harness.tui.getFocus()).not.toBe(harness.editor);
  });

  test("refreshes the picker when the deletion reports no match", async () => {
    const sessions = [session, secondSession];
    const harness = createHarness({
      sessions,
      deleteSession: () => {
        // Another process removed the session before this attempt resolved.
        sessions.splice(0, 1);
        return false;
      },
    });

    harness.controller.openResume();
    harness.press("K");
    harness.press("\x1b[B");
    harness.press("\r");
    await flush();

    const picker = harness.focused();

    expect(picker).toContain("Sessions");
    expect(picker).not.toContain("Test session");
    expect(selectedLine(picker)).toContain("Second session");
    expect(stripAnsi(harness.transcript.render(80).join("\n"))).toContain(
      "Session not found: session-1",
    );
    expect(harness.events).toEqual([]);
  });

  test("waits for asynchronous session disposal before refreshing the picker", async () => {
    const sessions = [session];
    let resolveDeletion: ((deleted: boolean) => void) | undefined;
    const deletion = new Promise<boolean>((resolve) => {
      resolveDeletion = resolve;
    });
    const harness = createHarness({ sessions, deleteSession: () => deletion });

    harness.controller.openResume();
    harness.press("K");
    harness.press("\x1b[B");
    harness.press("\r");

    expect(harness.focused()).toContain("Delete session?");
    expect(stripAnsi(harness.transcript.render(80).join("\n"))).not.toContain("Deleted session");

    sessions.splice(0, 1);
    resolveDeletion?.(true);
    await deletion;
    await flush();

    expect(stripAnsi(harness.transcript.render(80).join("\n"))).toContain(
      "Deleted session Test session.",
    );
    expect(harness.focused()).toContain("No saved sessions for this workspace.");
  });
});

function createHarness(options: {
  sessions: KanaSessionMetadata[];
  deleteSession?: (sessionId: string) => Promise<boolean> | boolean;
  hasCurrentSession?: boolean;
}) {
  const editor = new Editor({ model: "test-model" });
  const transcript = new Transcript();
  const layout = new AppLayout({ main: transcript, bottom: editor });
  const tui = createTuiStub();
  const events: string[] = [];
  const controller = new SessionOverlayController({
    editor,
    bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
    transcript,
    listSessions: () => options.sessions,
    deleteSession: options.deleteSession ?? (() => false),
    hasCurrentSession: () => options.hasCurrentSession ?? true,
    onResume: (sessionId) => events.push(`resume:${sessionId}`),
    onStop: () => events.push("stop"),
    onError: (error) => events.push(`error:${String(error)}`),
    updateStatus: (phase) => events.push(`status:${phase}`),
  });

  return {
    controller,
    editor,
    transcript,
    tui,
    events,
    render: () => stripAnsi(layout.render(80).join("\n")),
    focused: () => stripAnsi(tui.getFocus()?.render(80).join("\n") ?? ""),
    press: (data: string) => tui.getFocus()?.handleInput?.(data),
  };
}

function selectedLine(text: string): string {
  return text.split("\n").find((line) => line.startsWith("> ")) ?? "";
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createTuiStub(): Tui {
  let focusedComponent: Component | undefined;

  return {
    requestRender: () => {},
    getFocus: () => focusedComponent,
    setFocus: (component: Component | undefined) => {
      focusedComponent = component;
    },
  } as unknown as Tui;
}
