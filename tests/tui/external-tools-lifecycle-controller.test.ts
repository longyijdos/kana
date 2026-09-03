import { describe, expect, test } from "bun:test";
import {
  ExternalToolsLifecycleController,
  type ExternalToolsLoadResult,
} from "../../src/tui/app/external-tools-lifecycle-controller";
import { Transcript } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";
import type { Tui } from "../../src/tui/runtime";
import { deferred } from "../helpers/async-control";

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

  test("cancels startup without rendering a failure and restores interaction", async () => {
    let reportProgress!: (status: string) => void;
    const harness = createHarness((onProgress, signal) => {
      reportProgress = onProgress;
      return rejectOnAbort(signal);
    });

    const loading = harness.controller.load();
    expect(harness.controller.cancel()).toBe(true);
    expect(harness.controller.cancel()).toBe(false);
    expect(harness.controller.loading).toBe(true);
    reportProgress("stale startup progress");

    await expect(loading).resolves.toBe(true);
    expect(harness.controller.loading).toBe(false);
    expect(harness.render()).toEqual(["Starting MCP servers...", "MCP startup cancelled."]);
    expect(harness.events).toEqual([
      "status:starting",
      "focus:clear",
      "render",
      "tools:changed",
      "status:idle",
      "focus:editor",
      "render",
      "ready",
    ]);
  });

  test("cancels reload after cleanup settles and restores the editor", async () => {
    const harness = createHarness(undefined, (_onProgress, signal) => rejectOnAbort(signal));

    const reloading = harness.controller.reload();
    expect(harness.controller.cancel()).toBe(true);
    await reloading;

    expect(harness.controller.loading).toBe(false);
    expect(harness.render()).toEqual(["Reloading MCP servers...", "MCP reload cancelled."]);
    expect(harness.events).toEqual([
      "status:starting",
      "focus:clear",
      "render",
      "tools:changed",
      "status:idle",
      "focus:editor",
      "render",
      "ready",
    ]);
  });
});

function createHarness(
  load?: (
    onProgress: (status: string) => void,
    signal: AbortSignal,
  ) => Promise<ExternalToolsLoadResult>,
  reload?: (
    onProgress: (status: string) => void,
    signal: AbortSignal,
  ) => Promise<ExternalToolsLoadResult>,
) {
  const transcript = new Transcript();
  const events: string[] = [];
  const controller = new ExternalToolsLifecycleController({
    transcript,
    tui: {
      requestRender: () => events.push("render"),
    } as unknown as Tui,
    ...(load === undefined ? {} : { load }),
    ...(reload === undefined ? {} : { reload }),
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

function rejectOnAbort(signal: AbortSignal): Promise<ExternalToolsLoadResult> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
