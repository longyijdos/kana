import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { SessionOverlayController } from "../../src/tui/app/session-overlay-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

const session: KanaSessionMetadata = {
  id: "session-1",
  createdAt: "2026-07-19T00:00:00.000Z",
  title: "Test session",
  cwd: "/repo",
  path: "/sessions/session-1.jsonl",
};

describe("session overlay controller", () => {
  test("replaces the editor with the picker and restores it after cancel", () => {
    const editor = new Editor({ model: "test-model" });
    const transcript = new Transcript();
    const layout = new AppLayout({ main: transcript, bottom: editor });
    const tui = createTuiStub();
    const controller = new SessionOverlayController({
      editor,
      bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
      transcript,
      listSessions: () => [session],
      deleteSession: () => false,
      hasCurrentSession: () => true,
      onResume: () => {},
      onStop: () => {},
      onError: () => {},
      updateStatus: () => {},
    });

    controller.openResume();

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Sessions");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("test-model");

    tui.getFocus()?.handleInput?.("\x1b");

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("test-model");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("Sessions");
    expect(tui.getFocus()).toBe(editor);
  });

  test("waits for asynchronous session disposal before reporting deletion", async () => {
    const editor = new Editor({ model: "test-model" });
    const transcript = new Transcript();
    const layout = new AppLayout({ main: transcript, bottom: editor });
    const tui = createTuiStub();
    let resolveDeletion: ((deleted: boolean) => void) | undefined;
    const deletion = new Promise<boolean>((resolve) => {
      resolveDeletion = resolve;
    });
    const controller = new SessionOverlayController({
      editor,
      bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
      transcript,
      listSessions: () => [session],
      deleteSession: () => deletion,
      hasCurrentSession: () => true,
      onResume: () => {},
      onStop: () => {},
      onError: () => {},
      updateStatus: () => {},
    });

    controller.openDelete();
    tui.getFocus()?.handleInput?.("\r");
    tui.getFocus()?.handleInput?.("\x1b[B");
    tui.getFocus()?.handleInput?.("\r");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("Deleted session");

    resolveDeletion?.(true);
    await deletion;
    await Promise.resolve();

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Deleted session Test session.");
    expect(tui.getFocus()).toBe(editor);
  });
});

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
