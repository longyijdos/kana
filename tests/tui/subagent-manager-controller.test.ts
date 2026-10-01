import { describe, expect, test } from "bun:test";
import type { Message } from "@/core";
import type { KanaSubagentInspection } from "@/kana";
import { KanaSubagentManager, type KanaSubagentRunResult } from "../../src/kana/subagents";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { ContentViewerController } from "../../src/tui/app/content-viewer-controller";
import { SubagentManagerController } from "../../src/tui/app/subagent-manager-controller";
import {
  createSubagentInspectionView,
  Editor,
  type SubagentManager,
  Transcript,
} from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";
import { messageIdentityForTest } from "../helpers/messages";

describe("subagent manager controller", () => {
  test("pulls snapshots on demand and returns from detail to the same selected run", async () => {
    const manager = new KanaSubagentManager();
    const client = manager.bind(
      manager.createOwner({ sessionId: "session-1", cwd: process.cwd(), persistent: false }),
      { maxLive: 1 },
    );
    const profile = {
      name: "reviewer",
      description: "Review",
      instructions: "Review",
      tools: ["read"],
      digest: "test",
    };
    const earlier = client.start({
      profile,
      task: "Earlier review",
      spawnToolCallId: "earlier-spawn",
      run: async () => ({ status: "completed", output: "Earlier result", messages: [] }),
    });
    await client.wait(earlier.id, { waitMs: 100 });
    let messages: Message[] = [];
    let reads = 0;
    let settle!: (result: KanaSubagentRunResult) => void;
    const started = client.start({
      profile,
      task: "Review",
      spawnToolCallId: "spawn",
      run: ({ setLiveSnapshot }) => {
        setLiveSnapshot(() => {
          reads += 1;
          return { messages };
        });
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    });
    await Promise.resolve();

    const editor = new Editor({ model: "test" });
    const transcript = new Transcript();
    const layout = new AppLayout({ main: transcript, bottom: editor });
    let focused: Component | undefined;
    const tui = {
      getFocus: () => focused,
      setFocus: (component: Component | undefined) => {
        focused = component;
      },
      requestRender: () => {},
    } as unknown as Tui;
    const inspections: KanaSubagentInspection[] = [];
    const bottomArea = new BottomAreaController({ layout, tui, fallback: editor });
    const contentViewer = new ContentViewerController({ bottomArea, transcript });
    const controller = new SubagentManagerController({
      editor,
      bottomArea,
      tui,
      getSubagents: () => client,
      loadProfiles: () => ({ profiles: [profile], diagnostics: [] }),
      inspect: (inspection, onBack) => {
        inspections.push(inspection);
        contentViewer.open(createSubagentInspectionView(inspection), onBack);
      },
      showError: (error) => {
        throw error;
      },
      onClose: () => {},
    });
    const update = (text: string): void => {
      messages = [
        {
          ...messageIdentityForTest("assistant"),
          role: "assistant",
          content: [{ type: "text", text }],
        },
      ];
    };
    const render = () => stripAnsi(focused?.render(100).join("\n") ?? "");

    update("Initial progress");
    controller.open();
    focused?.handleInput?.("\x1b[B");
    const list = focused;
    expect(render()).toContain("Initial progress");
    update("Refreshed progress");
    expect(render()).not.toContain("Refreshed progress");
    expect(reads).toBe(1);
    focused?.handleInput?.("R");
    expect(render()).toContain("Refreshed progress");
    expect(reads).toBe(2);
    update("Latest transcript");
    focused?.handleInput?.("\r");
    expect(inspections[0]?.messages).toEqual(messages);
    expect(controller.active).toBe(true);
    expect(contentViewer.active).toBe(true);
    expect(reads).toBe(3);
    update("Progress while inspecting");
    expect(render()).toContain("Latest transcript");
    expect(render()).not.toContain("Progress while inspecting");
    expect(reads).toBe(3);

    focused?.handleInput?.("\x1b");
    expect(contentViewer.active).toBe(false);
    expect(focused).toBe(list);
    expect((focused as SubagentManager).selectedSubagent?.id).toBe(started.id);
    expect(render()).toContain("Progress while inspecting");
    expect(reads).toBe(4);
    focused?.handleInput?.("\x1b");
    expect(controller.active).toBe(false);
    expect(focused).toBe(editor);
    update("Progress after closing");
    render();
    expect(reads).toBe(4);

    settle({ status: "completed", output: "Done", messages });
    await client.wait(started.id, { waitMs: 100 });
    await manager.close();
  });
});
