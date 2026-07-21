import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createKanaMcpManager,
  type KanaMcpConfig,
  type KanaMcpHttpServerConfig,
  type KanaMcpServerConfig,
  type KanaMcpStdioServerConfig,
} from "@/kana";
import type { Logger, LogMetadata } from "@/logging";
import { type JsonRpcMessage, type McpManager, McpRequestTimeoutError } from "@/mcp";
import type { OAuthFetch, OAuthStoredToken, OAuthTokenStore } from "@/oauth";
import { normalizeToolResult } from "@/tools";

const fixturePath = path.resolve("tests/fixtures/mcp-stdio-server.ts");
const managers = new Set<McpManager>();
const httpServers = new Set<Bun.Server<unknown>>();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all([...managers].map((manager) => manager.close()));
  managers.clear();
  await Promise.all([...httpServers].map((server) => server.stop(true)));
  httpServers.clear();
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

  test("creates Streamable HTTP clients with configured headers and tools", async () => {
    const authorizations: Array<string | null> = [];
    const logs: Array<{ level: string; event: string; metadata?: LogMetadata }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorizations.push(request.headers.get("Authorization"));
        if (request.method === "GET") {
          return new Response(null, { status: 405 });
        }

        const message = (await request.json()) as JsonRpcMessage;
        if ("method" in message && message.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (!("method" in message) || !("id" in message)) {
          return new Response(null, { status: 202 });
        }
        if (message.method === "initialize") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-http-server", version: "1.0.0" },
            },
          });
        }
        if (message.method === "tools/list") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "echo",
                  inputSchema: { type: "object", additionalProperties: false },
                },
              ],
            },
          });
        }
        if (message.method === "tools/call") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: "remote" }],
              structuredContent: { transport: "http" },
            },
          });
        }
        return new Response(null, { status: 202 });
      },
    });
    httpServers.add(server);
    const manager = createManager(
      {
        remote: createHttpServerConfig({
          url: `http://127.0.0.1:${server.port}/mcp`,
          proxy: false,
          headers: { Authorization: "Bearer remote-token" },
        }),
      },
      {},
      createCapturingLogger(logs),
    );

    const tools = await manager.start();
    const result = normalizeToolResult(
      await tools[0]!.execute({}, { toolCallId: "call-http", update() {} }),
    );

    expect(tools.map((tool) => tool.name)).toEqual(["remote_echo"]);
    expect(result.result).toMatchObject({ structuredContent: { transport: "http" } });
    expect(authorizations).toContain("Bearer remote-token");
    expect(logs).toContainEqual({
      level: "debug",
      event: "mcp.http_proxy_bypassed",
      metadata: { serverId: "remote" },
    });
  });

  test("routes MCP and OAuth HTTP requests through the configured server proxy", async () => {
    const resource = "https://api.example.com/mcp";
    const issuer = "https://auth.example.com";
    const proxy = "http://127.0.0.1:7890";
    const requests: Array<{ url: string; proxy?: unknown; authorization: string | null }> = [];
    const logs: Array<{ level: string; event: string; metadata?: LogMetadata }> = [];
    let storedToken: OAuthStoredToken | undefined = {
      accessToken: "expired-token",
      tokenType: "Bearer",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 60_000,
      scopes: ["read"],
      issuer,
      clientId: "kana-client",
      resource,
    };
    const tokenStore: OAuthTokenStore = {
      async load() {
        return storedToken === undefined ? undefined : { ...storedToken };
      },
      async save(_key, token) {
        storedToken = { ...token };
      },
      async delete() {
        storedToken = undefined;
      },
    };
    const fetch: OAuthFetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        proxy: (init as (RequestInit & { proxy?: unknown }) | undefined)?.proxy,
        authorization: request.headers.get("Authorization"),
      });

      if (request.url === "https://api.example.com/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource,
          authorization_servers: [issuer],
          scopes_supported: ["read"],
          bearer_methods_supported: ["header"],
        });
      }
      if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (request.url === `${issuer}/token`) {
        return Response.json({
          access_token: "refreshed-token",
          token_type: "Bearer",
          refresh_token: "next-refresh-token",
          expires_in: 3_600,
          scope: "read",
        });
      }
      if (request.url !== resource) {
        throw new Error(`Unexpected proxied MCP request: ${request.method} ${request.url}`);
      }
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
      }

      const message = (await request.json()) as JsonRpcMessage;
      if ("method" in message && message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (!("method" in message) || !("id" in message)) {
        return new Response(null, { status: 202 });
      }
      if (message.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "proxied-server", version: "1.0.0" },
          },
        });
      }
      if (message.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "echo",
                inputSchema: { type: "object", additionalProperties: false },
              },
            ],
          },
        });
      }
      if (message.method === "tools/call") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "proxied" }] },
        });
      }
      return new Response(null, { status: 202 });
    };
    const logger = createCapturingLogger(logs);
    const manager = createKanaMcpManager(
      {
        mcpServers: {
          remote: createHttpServerConfig({
            url: resource,
            proxy,
            auth: {
              type: "oauth2",
              clientId: "kana-client",
              scopes: ["read"],
              authorizationParameters: {},
              callbackTimeoutMs: 300_000,
            },
          }),
        },
      },
      {
        enabledServerIds: ["remote"],
        clientInfo: { name: "kana-test", version: "1.0.0" },
        oauthFetch: fetch,
        oauthTokenStore: tokenStore,
        getLogger: () => logger,
      },
    );
    managers.add(manager);

    const tools = await manager.start();
    await tools[0]!.execute({}, { toolCallId: "call-proxy", update() {} });

    expect(requests.length).toBeGreaterThan(4);
    expect(requests.every((request) => request.proxy === proxy)).toBe(true);
    expect(requests.map((request) => request.url)).toEqual(
      expect.arrayContaining([
        "https://api.example.com/.well-known/oauth-protected-resource/mcp",
        "https://auth.example.com/.well-known/oauth-authorization-server",
        "https://auth.example.com/token",
        resource,
      ]),
    );
    expect(
      requests.some(
        (request) => request.url === resource && request.authorization === "Bearer refreshed-token",
      ),
    ).toBe(true);
    expect(logs).toContainEqual({
      level: "debug",
      event: "mcp.http_proxy_enabled",
      metadata: { serverId: "remote" },
    });
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
  servers: Record<string, KanaMcpServerConfig>,
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

function createHttpServerConfig(
  overrides: Partial<KanaMcpHttpServerConfig> = {},
): KanaMcpHttpServerConfig {
  return {
    type: "http",
    url: "https://example.com/mcp",
    headers: {},
    required: false,
    startupTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
