import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createKanaMcpRuntime,
  getKanaConfigPaths,
  type KanaMcpRuntime,
  type KanaMcpRuntimeProgressEvent,
  saveKanaMcpActivationState,
} from "@/kana";
import { McpRequestCancelledError } from "@/mcp";
import { waitFor } from "../../helpers/async-control";

const fixturePath = path.resolve("tests/fixtures/mcp-stdio-server.ts");
const runtimes = new Set<KanaMcpRuntime>();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all([...runtimes].map((runtime) => runtime.close()));
  runtimes.clear();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana MCP runtime", () => {
  test("replaces the manager from the latest activation state", async () => {
    const env = createTempEnv();
    writeMcpConfig(env, ["alpha", "beta"]);
    saveKanaMcpActivationState({ enabledServers: ["alpha"] }, env);
    const events: KanaMcpRuntimeProgressEvent[] = [];
    const runtime = createRuntime(env, events);

    const initial = await runtime.start();

    expect(initial.selectedServerIds).toEqual(["alpha"]);
    expect(initial.tools.map((tool) => tool.name)).toEqual(["alpha_echo", "alpha_slow"]);
    expect(runtime.getToolSource("alpha_echo")).toEqual({
      serverId: "alpha",
      remoteToolName: "echo",
    });

    saveKanaMcpActivationState({ enabledServers: ["beta"] }, env);
    const reloaded = await runtime.reload();

    expect(reloaded.selectedServerIds).toEqual(["beta"]);
    expect(reloaded.tools.map((tool) => tool.name)).toEqual(["beta_echo", "beta_slow"]);
    expect(runtime.getToolSource("alpha_echo")).toBeUndefined();
    expect(runtime.getToolSource("beta_echo")).toEqual({
      serverId: "beta",
      remoteToolName: "echo",
    });
    expect(events.some((event) => event.runtimeOperation === "reload")).toBe(true);

    await runtime.close();
    expect(runtime.tools).toEqual([]);
    expect(runtime.selectedServerIds).toEqual([]);
    expect(runtime.getToolSource("beta_echo")).toBeUndefined();
  });

  test("leaves no stale tools after a reload configuration error and can recover", async () => {
    const env = createTempEnv();
    writeMcpConfig(env, ["alpha"]);
    saveKanaMcpActivationState({ enabledServers: ["alpha"] }, env);
    const runtime = createRuntime(env);
    await runtime.start();

    writeFileSync(getKanaConfigPaths(env).mcpConfigPath, "{");

    await expect(runtime.reload()).rejects.toThrow("Failed to parse MCP config:");
    expect(runtime.tools).toEqual([]);
    expect(runtime.diagnostics).toEqual([]);
    expect(runtime.getToolSource("alpha_echo")).toBeUndefined();

    writeMcpConfig(env, ["alpha"]);
    const recovered = await runtime.reload();
    expect(recovered.tools.map((tool) => tool.name)).toEqual(["alpha_echo", "alpha_slow"]);
  });

  test("serializes concurrent reloads and labels manager progress by runtime operation", async () => {
    const env = createTempEnv();
    writeMcpConfig(env, ["alpha"]);
    saveKanaMcpActivationState({ enabledServers: ["alpha"] }, env);
    const events: KanaMcpRuntimeProgressEvent[] = [];
    const runtime = createRuntime(env, events);
    await runtime.start();
    events.length = 0;

    await Promise.all([runtime.reload(), runtime.reload()]);

    expect(
      events
        .filter((event) => event.completedServerCount === 0)
        .map((event) => [event.runtimeOperation, event.operation]),
    ).toEqual([
      ["reload", "close"],
      ["reload", "start"],
      ["reload", "close"],
      ["reload", "start"],
    ]);
  });

  test("cancels startup, closes its manager, and permits a later reload", async () => {
    const env = createTempEnv();
    writeMcpConfig(env, ["alpha"], "hang-initialize");
    saveKanaMcpActivationState({ enabledServers: ["alpha"] }, env);
    const events: KanaMcpRuntimeProgressEvent[] = [];
    const runtime = createRuntime(env, events);
    const controller = new AbortController();

    const starting = runtime.start({ signal: controller.signal });
    await waitFor(() =>
      events.some((event) => event.runtimeOperation === "start" && event.operation === "start"),
    );
    controller.abort(new Error("skip MCP startup"));

    await expect(starting).rejects.toBeInstanceOf(McpRequestCancelledError);
    expect(runtime.tools).toEqual([]);
    expect(runtime.diagnostics.every((diagnostic) => diagnostic.status === "closed")).toBe(true);

    writeMcpConfig(env, ["alpha"]);
    const reloaded = await runtime.reload();
    expect(reloaded.tools.map((tool) => tool.name)).toEqual(["alpha_echo", "alpha_slow"]);
  });

  test("enforces lifecycle ordering and closes idempotently", async () => {
    const runtime = createRuntime(createTempEnv());

    await expect(runtime.reload()).rejects.toThrow(
      "MCP runtime must be started before it can reload.",
    );
    await runtime.start();
    await expect(runtime.start()).rejects.toThrow("MCP runtime can only be started once.");

    const firstClose = runtime.close();
    expect(runtime.close()).toBe(firstClose);
    await firstClose;
    await expect(runtime.reload()).rejects.toThrow("MCP runtime is closing or closed.");
  });
});

function createRuntime(
  env: NodeJS.ProcessEnv,
  events?: KanaMcpRuntimeProgressEvent[],
): KanaMcpRuntime {
  const runtime = createKanaMcpRuntime({
    env,
    clientInfo: { name: "kana-runtime-test", version: "1.0.0" },
    ...(events === undefined ? {} : { onProgress: (event) => events.push(event) }),
  });
  runtimes.add(runtime);
  return runtime;
}

function writeMcpConfig(env: NodeJS.ProcessEnv, serverIds: string[], scenario?: string): void {
  const { home, mcpConfigPath } = getKanaConfigPaths(env);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    mcpConfigPath,
    `${JSON.stringify(
      {
        mcpServers: Object.fromEntries(
          serverIds.map((serverId) => [
            serverId,
            {
              command: process.execPath,
              args: [fixturePath],
              ...(scenario === undefined ? {} : { env: { KANA_TEST_MCP_SCENARIO: scenario } }),
              startupTimeoutMs: 1_000,
              requestTimeoutMs: 1_000,
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-mcp-runtime-"));
  tempDirs.push(home);
  return {
    HOME: home,
    PATH: process.env.PATH,
  };
}
