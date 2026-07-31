import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_KANA_MCP_ACTIVATION_STATE,
  getKanaConfigPaths,
  loadKanaMcpActivationState,
  loadKanaMcpServerActivations,
  parseKanaMcpActivationState,
  saveKanaMcpActivationState,
} from "@/kana";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Kana MCP activation state", () => {
  test("defaults to no enabled servers when mcp-enabled.json is missing", () => {
    expect(loadKanaMcpActivationState(createTempEnv())).toEqual(DEFAULT_KANA_MCP_ACTIVATION_STATE);
  });

  test("loads and snapshots enabled server IDs", () => {
    const env = createTempEnv();
    const state = { enabledServers: ["filesystem", "github"] };
    writeFileSync(getKanaConfigPaths(env).mcpEnabledPath, `${JSON.stringify(state)}\n`);

    expect(loadKanaMcpActivationState(env)).toEqual(state);

    const parsed = parseKanaMcpActivationState(state);
    state.enabledServers[0] = "changed";
    expect(parsed).toEqual({ enabledServers: ["filesystem", "github"] });
  });

  test("combines configured servers with activation state for management", () => {
    const env = createTempEnv();
    const { mcpConfigPath } = getKanaConfigPaths(env);
    writeFileSync(
      mcpConfigPath,
      `${JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
            env: { SECRET_TOKEN: "not-exposed" },
          },
          github: { command: "/usr/local/bin/github-mcp" },
          remote: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "not-exposed" },
          },
        },
      })}\n`,
    );
    saveKanaMcpActivationState({ enabledServers: ["github", "remote", "removed"] }, env);

    expect(loadKanaMcpServerActivations(env)).toEqual([
      {
        id: "filesystem",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        enabled: false,
      },
      {
        id: "github",
        type: "stdio",
        command: "/usr/local/bin/github-mcp",
        args: [],
        enabled: true,
      },
      {
        id: "remote",
        type: "http",
        url: "https://example.com/mcp",
        enabled: true,
      },
    ]);
  });

  test("saves deterministic user-only JSON", () => {
    const env = createTempEnv();
    const { mcpEnabledPath } = getKanaConfigPaths(env);

    saveKanaMcpActivationState({ enabledServers: ["github", "filesystem"] }, env);

    expect(readFileSync(mcpEnabledPath, "utf8")).toBe(
      ["{", '  "enabledServers": [', '    "github",', '    "filesystem"', "  ]", "}", ""].join(
        "\n",
      ),
    );
    expect(statSync(mcpEnabledPath).mode & 0o777).toBe(0o600);
  });

  test("rejects invalid activation state", () => {
    expect(() => parseKanaMcpActivationState([])).toThrow(
      "MCP activation state must be a JSON object.",
    );
    expect(() => parseKanaMcpActivationState({ enabledServers: "filesystem" })).toThrow(
      "MCP activation state.enabledServers must be an array of server IDs.",
    );
    expect(() => parseKanaMcpActivationState({ enabledServers: [""] })).toThrow(
      "MCP activation state.enabledServers[0] must be a non-empty string.",
    );
    expect(() =>
      parseKanaMcpActivationState({ enabledServers: ["filesystem", "filesystem"] }),
    ).toThrow("MCP activation state.enabledServers cannot contain duplicate server IDs.");
    expect(() => parseKanaMcpActivationState({ enabledServers: [], typo: true })).toThrow(
      "MCP activation state contains unknown field typo.",
    );
  });

  test("wraps invalid JSON with the activation-state path", () => {
    const env = createTempEnv();
    const { mcpEnabledPath } = getKanaConfigPaths(env);
    writeFileSync(mcpEnabledPath, "{");

    expect(() => loadKanaMcpActivationState(env)).toThrow(
      `Failed to parse MCP activation state: ${mcpEnabledPath}`,
    );
  });
});

function createTempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "kana-mcp-activation-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".kana"), { recursive: true });
  return { HOME: home };
}
