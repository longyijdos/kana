import { describe, expect, test } from "bun:test";
import type { KanaSessionMetadata } from "@/kana";
import { AppLayout } from "../src/tui/app/app-layout";
import { SessionOverlayController } from "../src/tui/app/session-overlay-controller";
import { Editor, Transcript } from "../src/tui/components";
import { stripAnsi } from "../src/tui/render";
import type { Component, Tui } from "../src/tui/runtime";

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
    const restoreCalls: boolean[] = [];
    const restoreBottom = (focus: boolean): void => {
      restoreCalls.push(focus);
      layout.showBottom(editor);
      if (focus) {
        tui.setFocus(editor);
      }
    };
    const controller = new SessionOverlayController({
      editor,
      layout,
      transcript,
      tui,
      listSessions: () => [session],
      deleteSession: () => false,
      hasCurrentSession: () => true,
      onResume: () => {},
      onStop: () => {},
      updateStatus: () => {},
      restoreBottom,
    });

    controller.openResume();

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("Sessions");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("test-model");

    tui.getFocus()?.handleInput?.("\x1b");

    expect(stripAnsi(layout.render(80).join("\n"))).toContain("test-model");
    expect(stripAnsi(layout.render(80).join("\n"))).not.toContain("Sessions");
    expect(tui.getFocus()).toBe(editor);
    expect(restoreCalls).toEqual([true]);
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
