import { describe, expect, test } from "bun:test";
import {
  ExternalToolsLifecycleController,
  type ExternalToolsLoadResult,
} from "../../src/tui/app/external-tools-lifecycle-controller";
import { Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Tui } from "../../src/tui/runtime";

describe("external tools lifecycle controller", () => {
  test("renders startup progress before enabling tools and editor focus", async () => {
    const pending = deferred<ExternalToolsLoadResult>();
    let reportProgress: ((status: string) => void) | undefined;
    const harness = createHarness((onProgress) => {
      reportProgress = onProgress;
      return pending.promise;
    });

    const loading = harness.controller.load();

    expect(harness.controller.loading).toBe(true);
    expect(harness.render()).toEqual(["Starting MCP servers..."]);
    expect(harness.events).toEqual(["status:starting", "focus:clear", "render"]);

    reportProgress?.("[1/2] MCP server github ready · 3 tools.");
    pending.resolve({
      warnings: ["MCP server optional failed to start: unavailable"],
      status: "MCP startup complete: 1/2 servers ready · 3 tools",
    });

    await expect(loading).resolves.toBe(true);
    expect(harness.controller.loading).toBe(false);
    expect(harness.render()).toEqual([
      "Starting MCP servers...",
      "[1/2] MCP server github ready · 3 tools.",
      "MCP server optional failed to start: unavailable",
      "MCP startup complete: 1/2 servers ready · 3 tools",
    ]);
    expect(harness.events).toEqual([
      "status:starting",
      "focus:clear",
      "render",
      "render",
      "tools:changed",
      "status:idle",
      "focus:editor",
      "render",
      "ready",
    ]);
  });

  test("keeps interaction disabled when required tools fail to load", async () => {
    const harness = createHarness(async () => {
      throw new Error("Required MCP servers failed to start: filesystem.");
    });

    await expect(harness.controller.load()).resolves.toBe(false);

    expect(harness.controller.loading).toBe(false);
    expect(harness.render()).toEqual([
      "Starting MCP servers...",
      "Failed to load external tools: Required MCP servers failed to start: filesystem.",
      "Press Ctrl+C to exit.",
    ]);
    expect(harness.events).toEqual([
      "status:starting",
      "focus:clear",
      "render",
      "status:error",
      "render",
    ]);
  });
});

function createHarness(
  load: (onProgress: (status: string) => void) => Promise<ExternalToolsLoadResult>,
) {
  const transcript = new Transcript();
  const events: string[] = [];
  const controller = new ExternalToolsLifecycleController({
    transcript,
    tui: {
      requestRender: () => events.push("render"),
    } as unknown as Tui,
    load,
    isStopping: () => false,
    onToolsChanged: () => events.push("tools:changed"),
    onReady: () => events.push("ready"),
    updateStatus: (phase) => events.push(`status:${phase}`),
    focusEditor: () => events.push("focus:editor"),
    clearFocus: () => events.push("focus:clear"),
  });

  return {
    controller,
    events,
    render: () => transcript.render(100).map(stripAnsi).filter(Boolean),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}
