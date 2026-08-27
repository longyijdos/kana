import { describe, expect, test } from "bun:test";
import { AppLayout } from "../../src/tui/app/app-layout";
import { BottomAreaController } from "../../src/tui/app/bottom-area-controller";
import { McpServerManagerController } from "../../src/tui/app/mcp-server-manager-controller";
import { Editor, TextBlock, Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Component, Tui } from "../../src/tui/runtime";

describe("MCP server manager controller", () => {
  test("saves and reloads once when an edited draft closes", () => {
    const harness = createHarness();

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\r");
    expect(harness.saved).toEqual([]);
    expect(harness.closed).toEqual([]);

    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.saved).toEqual([["filesystem", "github"]]);
    expect(harness.closed).toEqual([true]);
    expect(harness.tui.getFocus()).toBe(harness.editor);
    expect(harness.layout.isBottom(harness.editor)).toBe(true);
  });

  test("closes an unchanged draft without saving or reloading", () => {
    const harness = createHarness();

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.saved).toEqual([]);
    expect(harness.closed).toEqual([false]);
  });

  test("keeps the manager open when activation persistence fails", () => {
    const harness = createHarness(() => {
      throw new Error("activation write failed");
    });

    harness.controller.open();
    harness.tui.getFocus()?.handleInput?.("\r");
    harness.tui.getFocus()?.handleInput?.("\x1b");

    expect(harness.controller.active).toBe(true);
    expect(harness.closed).toEqual([]);
    expect(harness.tui.getFocus()).not.toBe(harness.editor);
    expect(stripAnsi(harness.transcript.render(80).join("\n"))).toContain(
      "activation write failed",
    );
  });

  test("runs browser authorization from the auth menu and reloads an enabled server", async () => {
    const editor = new Editor({ model: "test-model" });
    const transcript = new Transcript();
    const layout = new AppLayout({ main: transcript, bottom: editor });
    const tui = createTuiStub();
    const closed: boolean[] = [];
    const statusPhases: string[] = [];
    let resolveAuthorization!: (status: { state: "authorized"; refreshable: boolean }) => void;
    const authorization = new Promise<{
      state: "authorized";
      refreshable: boolean;
    }>((resolve) => {
      resolveAuthorization = resolve;
    });
    const controller = new McpServerManagerController({
      editor,
      bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
      transcript,
      tui,
      loadServers: () => [
        {
          id: "github",
          type: "http",
          url: "https://example.com/mcp",
          enabled: true,
          oauth: { type: "oauth2", state: "unauthorized", refreshable: false },
        },
      ],
      saveEnabledServerIds: () => {
        throw new Error("Activation should not change during authorization.");
      },
      authorizeServer: async (serverId, onAuthorizationUrl, signal) => {
        expect(serverId).toBe("github");
        expect(signal.aborted).toBe(false);
        onAuthorizationUrl("https://auth.example.com/authorize?state=temporary");
        return authorization;
      },
      showError: (error) => {
        transcript.addChild(new TextBlock(error instanceof Error ? error.message : String(error)));
      },
      onClose: (changed) => closed.push(changed),
      updateStatus: (phase) => statusPhases.push(phase),
    });

    controller.open();
    tui.getFocus()?.handleInput?.("A");
    tui.getFocus()?.handleInput?.("\r");
    expect(stripAnsi(transcript.render(100).join("\n"))).toContain(
      "https://auth.example.com/authorize?state=temporary",
    );

    resolveAuthorization({ state: "authorized", refreshable: true });
    await waitFor(() =>
      stripAnsi(transcript.render(100).join("\n")).includes("MCP OAuth authorized: github."),
    );
    tui.getFocus()?.handleInput?.("\x1b");

    expect(statusPhases).toEqual(["starting", "idle"]);
    expect(closed).toEqual([true]);
    expect(tui.getFocus()).toBe(editor);
  });
});

function createHarness(save?: (serverIds: string[]) => void) {
  const editor = new Editor({ model: "test-model" });
  const transcript = new Transcript();
  const layout = new AppLayout({ main: transcript, bottom: editor });
  const tui = createTuiStub();
  const saved: string[][] = [];
  const closed: boolean[] = [];
  const controller = new McpServerManagerController({
    editor,
    bottomArea: new BottomAreaController({ layout, tui, fallback: editor }),
    transcript,
    tui,
    loadServers: () => [
      { id: "filesystem", type: "stdio", command: "npx", args: ["-y"], enabled: false },
      { id: "github", type: "stdio", command: "github-mcp", args: [], enabled: true },
    ],
    saveEnabledServerIds: (serverIds) => {
      saved.push(serverIds);
      save?.(serverIds);
    },
    showError: (error) => {
      transcript.addChild(new TextBlock(error instanceof Error ? error.message : String(error)));
    },
    onClose: (changed) => closed.push(changed),
    updateStatus: () => {},
  });

  return { controller, editor, transcript, layout, tui, saved, closed };
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for MCP OAuth controller state.");
}
