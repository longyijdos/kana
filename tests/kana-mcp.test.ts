import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKanaMcpManager, type KanaMcpConfig, type KanaMcpStdioServerConfig } from "@/kana";
import type { Logger, LogMetadata } from "@/logging";
import { type McpManager, McpRequestTimeoutError } from "@/mcp";
import { normalizeToolResult } from "@/tools";

const fixturePath = path.resolve("tests/fixtures/mcp-stdio-server.ts");
const managers = new Set<McpManager>();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all([...managers].map((manager) => manager.close()));
  managers.clear();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana MCP composition", () => {
  test("creates stdio clients with filtered environment, cwd, args, and tools", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "kana-mcp-"));
    tempDirs.push(cwd);
    const logs: Array<{ level: string; event: string; metadata?: LogMetadata }> = [];
    const logger = createCapturingLogger(logs);
    const manager = createManager(
      {
        fixture: createServerConfig({
          args: [fixturePath, "marker"],
          cwd,
          env: {
            KANA_TEST_MCP_SCENARIO: "inspect-environment",
            ALLOWED_SECRET: "visible",
          },
          includeTools: ["echo"],
        }),
      },
      {
        HOME: "/safe-home",
        PATH: process.env.PATH,
        BLOCKED_SECRET: "hidden",
      },
      logger,
    );

    const tools = await manager.start();
    const result = normalizeToolResult(
      await tools[0]!.execute({ text: "hello" }, { toolCallId: "call-1", update() {} }),
    );

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_echo"]);
    expect(result.result).toMatchObject({
      structuredContent: {
        cwd: realpathSync(cwd),
        argv: ["marker"],
        env: {
          HOME: "/safe-home",
          ALLOWED_SECRET: "visible",
        },
      },
    });
    expect(result.result).not.toMatchObject({
      structuredContent: { env: { BLOCKED_SECRET: "hidden" } },
    });
    expect(logs).toContainEqual({
      level: "debug",
      event: "mcp.server_stderr",
      metadata: {
        serverId: "fixture",
        content: expect.stringContaining("fake MCP server started"),
      },
    });
  });

  test("uses configured request timeouts", async () => {
    const manager = createManager(
      {
        slow: createServerConfig({
          args: [fixturePath],
          env: { KANA_TEST_MCP_SCENARIO: "hang" },
          includeTools: ["slow"],
          requestTimeoutMs: 20,
        }),
      },
      {
        PATH: process.env.PATH,
      },
    );
    const tools = await manager.start();

    await expect(
      tools[0]!.execute({}, { toolCallId: "call-1", update() {} }),
    ).rejects.toBeInstanceOf(McpRequestTimeoutError);
  });

  test("creates clients only for selected server IDs", async () => {
    const disabledAll = createKanaMcpManager({ mcpServers: {} }, { enabledServerIds: ["unknown"] });
    const unselectedServer = createManager(
      {
        broken: createServerConfig({ command: "/does/not/exist" }),
      },
      {},
      undefined,
      ["unknown"],
    );
    managers.add(disabledAll);

    await expect(disabledAll.start()).resolves.toEqual([]);
    await expect(unselectedServer.start()).resolves.toEqual([]);
    expect(disabledAll.diagnostics).toEqual([]);
    expect(unselectedServer.diagnostics).toEqual([]);
  });

  test("reports optional stdio startup failures through the current logger", async () => {
    const firstLogs: Array<{ level: string; event: string; metadata?: LogMetadata }> = [];
    const secondLogs: Array<{ level: string; event: string; metadata?: LogMetadata }> = [];
    let logger = createCapturingLogger(firstLogs);
    const manager = createKanaMcpManager(
      {
        mcpServers: {
          missing: createServerConfig({ command: "/does/not/exist" }),
        },
      },
      { enabledServerIds: ["missing"], getLogger: () => logger },
    );
    managers.add(manager);
    logger = createCapturingLogger(secondLogs);

    await expect(manager.start()).resolves.toEqual([]);

    expect(firstLogs).toEqual([]);
    expect(secondLogs.some((record) => record.event === "mcp.server_start_failed")).toBe(true);
  });
});

function createManager(
  servers: Record<string, KanaMcpStdioServerConfig>,
  env: NodeJS.ProcessEnv = {},
  logger?: Logger,
  enabledServerIds: Iterable<string> = Object.keys(servers),
): McpManager {
  const config: KanaMcpConfig = { mcpServers: servers };
  const manager = createKanaMcpManager(config, {
    enabledServerIds,
    env,
    ...(logger === undefined ? {} : { getLogger: () => logger }),
    clientInfo: { name: "kana-test", version: "1.0.0" },
  });
  managers.add(manager);
  return manager;
}

function createServerConfig(
  overrides: Partial<KanaMcpStdioServerConfig> = {},
): KanaMcpStdioServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: [fixturePath],
    env: {},
    required: false,
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
}

function createCapturingLogger(
  records: Array<{ level: string; event: string; metadata?: LogMetadata }>,
): Logger {
  return {
    debug: (event, metadata) => records.push({ level: "debug", event, metadata }),
    info: (event, metadata) => records.push({ level: "info", event, metadata }),
    warn: (event, metadata) => records.push({ level: "warn", event, metadata }),
    error: (event, metadata) => records.push({ level: "error", event, metadata }),
  };
}
