import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_KANA_MCP_CONFIG,
  getKanaConfigPaths,
  loadKanaMcpConfig,
  parseKanaMcpConfig,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana MCP config", () => {
  test("loads an empty default when mcp.json is missing", () => {
    expect(loadKanaMcpConfig(createTempEnv())).toEqual(DEFAULT_KANA_MCP_CONFIG);
  });

  test("loads Claude-style stdio server entries", () => {
    const env = createTempEnv();
    const config = {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"],
        },
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxxx" },
          required: true,
          startupTimeoutMs: 5_000,
          requestTimeoutMs: 30_000,
          includeTools: ["create_issue", "list_issues"],
          excludeTools: ["list_issues"],
        },
      },
    };
    writeFileSync(getKanaConfigPaths(env).mcpConfigPath, `${JSON.stringify(config)}\n`);

    expect(loadKanaMcpConfig(env)).toEqual({
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"],
          env: {},
          required: false,
          startupTimeoutMs: 10_000,
          requestTimeoutMs: 60_000,
        },
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxxx" },
          required: true,
          startupTimeoutMs: 5_000,
          requestTimeoutMs: 30_000,
          includeTools: ["create_issue", "list_issues"],
          excludeTools: ["list_issues"],
        },
      },
    });
  });

  test("defaults an omitted mcpServers object to empty", () => {
    expect(parseKanaMcpConfig({})).toEqual({ mcpServers: {} });
  });

  test("snapshots mutable values supplied by callers", () => {
    const raw = {
      mcpServers: {
        mutable: {
          command: "mcp-server",
          args: ["before"],
          env: { TOKEN: "before" },
          includeTools: ["before"],
        },
      },
    };
    const parsed = parseKanaMcpConfig(raw);

    raw.mcpServers.mutable.args[0] = "after";
    raw.mcpServers.mutable.env.TOKEN = "after";
    raw.mcpServers.mutable.includeTools[0] = "after";

    expect(parsed.mcpServers.mutable).toMatchObject({
      args: ["before"],
      env: { TOKEN: "before" },
      includeTools: ["before"],
    });
  });

  test("rejects unsupported server types and unknown fields", () => {
    expect(() =>
      parseKanaMcpConfig({
        mcpServers: {
          remote: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    ).toThrow("mcpServers.remote.type must be one of: stdio.");
    expect(() =>
      parseKanaMcpConfig({
        mcpServers: {
          typo: { command: "mcp-server", arguments: [] },
        },
      }),
    ).toThrow("mcpServers.typo contains unknown field arguments.");
    expect(() =>
      parseKanaMcpConfig({
        mcpServers: {
          legacy: { command: "mcp-server", enabled: true },
        },
      }),
    ).toThrow("mcpServers.legacy contains unknown field enabled.");
  });

  test("rejects invalid environment values", () => {
    expect(() =>
      parseKanaMcpConfig({
        mcpServers: {
          invalidName: { command: "mcp-server", env: { "GITHUB-TOKEN": "secret" } },
        },
      }),
    ).toThrow("mcpServers.invalidName.env contains invalid environment name GITHUB-TOKEN.");
    expect(() =>
      parseKanaMcpConfig({
        mcpServers: {
          invalidValue: { command: "mcp-server", env: { TOKEN: 42 } },
        },
      }),
    ).toThrow("mcpServers.invalidValue.env.TOKEN must be a string.");
  });

  test("rejects invalid timeouts and tool filters", () => {
    expect(() =>
      parseKanaMcpConfig({
        mcpServers: {
          timeout: { command: "mcp-server", requestTimeoutMs: 0 },
        },
      }),
    ).toThrow("mcpServers.timeout.requestTimeoutMs must be a positive integer.");
    expect(() =>
      parseKanaMcpConfig({
        mcpServers: {
          filters: { command: "mcp-server", includeTools: [""] },
        },
      }),
    ).toThrow("mcpServers.filters.includeTools values must be non-empty strings.");
  });

  test("wraps invalid JSON with the MCP config path", () => {
    const env = createTempEnv();
    const { mcpConfigPath } = getKanaConfigPaths(env);
    writeFileSync(mcpConfigPath, "{");

    expect(() => loadKanaMcpConfig(env)).toThrow(`Failed to parse MCP config: ${mcpConfigPath}`);
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-mcp-config-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".kana"), { recursive: true });
  return { HOME: home };
}
