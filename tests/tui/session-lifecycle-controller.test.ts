import { describe, expect, test } from "bun:test";
import type { ConversationRuntime } from "@/kana";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import type { TuiModelSelection } from "../../src/tui/app/model-selection";
import { SessionLifecycleController } from "../../src/tui/app/session-lifecycle-controller";
import { Editor, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("session lifecycle controller", () => {
  test("forks the conversation before clearing overlays and submitting the prompt", async () => {
    const events: string[] = [];
    const editor = new Editor({ model: "test-model" });
    editor.setText("draft");
    const transcript = new Transcript();
    const tui = createTuiStub(events);
    const layout = new AppLayout({ main: transcript, bottom: editor });
    const conversation = {
      sessionId: "source-session",
      listSessions: () => [],
      forkSession: async (prompt: string) => {
        events.push(`fork:${prompt}`);
        return { id: "fork-session", messages: [], timeline: [] };
      },
    } as unknown as ConversationRuntime<TuiModelSelection>;
    const controller = new SessionLifecycleController({
      conversation,
      editor,
      bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
      transcript,
      tui,
      isRunning: () => false,
      closeOtherOverlays: () => events.push("overlays:close"),
      closeContentViewer: () => events.push("viewer:close"),
      resetAgentEvents: () => events.push("events:reset"),
      clearMcpOAuthBlocks: () => events.push("oauth:clear"),
      updateContextUsage: () => events.push("context:update"),
      updateStatus: (phase) => events.push(`status:${phase}`),
      showError: () => events.push("error"),
      stop: () => events.push("stop"),
      submitPrompt: async (prompt) => {
        events.push(`submit:${prompt}`);
      },
      activateSession: () => events.push("session:activate"),
    });

    await controller.fork("Continue on the fork.");

    expect(editor.getText()).toBe("");
    expect(stripAnsi(transcript.render(80).join("\n"))).toContain("Forked session fork-session.");
    expect(events).toEqual([
      "fork:Continue on the fork.",
      "viewer:close",
      "status:idle",
      "render",
      "submit:Continue on the fork.",
    ]);
  });
});

function createTuiStub(events: string[]): Tui {
  let focusedComponent: Component | undefined;

  return {
    requestRender: () => events.push("render"),
    getFocus: () => focusedComponent,
    setFocus: (component: Component | undefined) => {
      focusedComponent = component;
    },
  } as unknown as Tui;
}
