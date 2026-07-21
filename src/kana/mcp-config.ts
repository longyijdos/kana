import { existsSync, readFileSync } from "node:fs";
import { getKanaConfigPaths } from "./config";

export const KANA_MCP_SERVER_TYPES = ["stdio"] as const;

export type KanaMcpServerType = (typeof KANA_MCP_SERVER_TYPES)[number];

export type KanaMcpStdioServerConfig = {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  required: boolean;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  includeTools?: string[];
  excludeTools?: string[];
};

// Future HTTP and SSE configurations extend this discriminated union. Stdio
// keeps `type` optional in JSON for compatibility with common MCP config files.
export type KanaMcpServerConfig = KanaMcpStdioServerConfig;

export type KanaMcpConfig = {
  mcpServers: Record<string, KanaMcpServerConfig>;
};

export const DEFAULT_KANA_MCP_CONFIG: KanaMcpConfig = {
  mcpServers: {},
};

const ROOT_KEYS = new Set(["mcpServers"]);
const STDIO_SERVER_KEYS = new Set([
  "type",
  "command",
  "args",
  "cwd",
  "env",
  "required",
  "startupTimeoutMs",
  "requestTimeoutMs",
  "includeTools",
  "excludeTools",
]);

export function loadKanaMcpConfig(env: NodeJS.ProcessEnv = process.env): KanaMcpConfig {
  const { mcpConfigPath } = getKanaConfigPaths(env);
  if (!existsSync(mcpConfigPath)) {
    return { mcpServers: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse MCP config: ${mcpConfigPath}`, { cause: error });
  }

  return parseKanaMcpConfig(parsed);
}

export function parseKanaMcpConfig(value: unknown): KanaMcpConfig {
  const root = asRecord(value, "MCP config");
  assertKnownKeys(root, ROOT_KEYS, "MCP config");
  const rawServers = root.mcpServers === undefined ? {} : asRecord(root.mcpServers, "mcpServers");

  return {
    mcpServers: Object.fromEntries(
      Object.entries(rawServers).map(([serverId, rawServer]) => [
        validateServerId(serverId),
        parseStdioServer(serverId, rawServer),
      ]),
    ),
  };
}

function parseStdioServer(serverId: string, value: unknown): KanaMcpStdioServerConfig {
  const name = `mcpServers.${serverId}`;
  const server = asRecord(value, name);
  const type = readString(server.type, "stdio", `${name}.type`);
  if (!(KANA_MCP_SERVER_TYPES as readonly string[]).includes(type)) {
    throw new Error(`${name}.type must be one of: ${KANA_MCP_SERVER_TYPES.join(", ")}.`);
  }
  assertKnownKeys(server, STDIO_SERVER_KEYS, name);

  const cwd = readOptionalNonBlankString(server.cwd, `${name}.cwd`);
  const includeTools = readOptionalToolNames(server.includeTools, `${name}.includeTools`);
  const excludeTools = readOptionalToolNames(server.excludeTools, `${name}.excludeTools`);

  return {
    type: "stdio",
    command: readRequiredNonBlankString(server.command, `${name}.command`),
    args: readStringArray(server.args, [], `${name}.args`),
    ...(cwd === undefined ? {} : { cwd }),
    env: readEnvironment(server.env, `${name}.env`),
    required: readBoolean(server.required, false, `${name}.required`),
    startupTimeoutMs: readPositiveInteger(
      server.startupTimeoutMs,
      10_000,
      `${name}.startupTimeoutMs`,
    ),
    requestTimeoutMs: readPositiveInteger(
      server.requestTimeoutMs,
      60_000,
      `${name}.requestTimeoutMs`,
    ),
    ...(includeTools === undefined ? {} : { includeTools }),
    ...(excludeTools === undefined ? {} : { excludeTools }),
  };
}

function validateServerId(value: string): string {
  if (!value.trim()) {
    throw new Error("mcpServers keys must be non-empty server IDs.");
  }
  return value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`${name} contains unknown field ${unknown}.`);
  }
}

function readString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function readRequiredNonBlankString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function readOptionalNonBlankString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : readRequiredNonBlankString(value, name);
}

function readBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readStringArray(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) {
    return fallback.slice();
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value.slice();
}

function readOptionalToolNames(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const names = readStringArray(value, [], name);
  if (names.some((toolName) => !toolName.trim())) {
    throw new Error(`${name} values must be non-empty strings.`);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`${name} cannot contain duplicate values.`);
  }
  return names;
}

function readEnvironment(value: unknown, name: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const env = asRecord(value, name);
  for (const [envName, envValue] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error(`${name} contains invalid environment name ${envName}.`);
    }
    if (typeof envValue !== "string") {
      throw new Error(`${name}.${envName} must be a string.`);
    }
  }
  // Configuration objects may be supplied directly by callers rather than
  // loaded from disk. Snapshot the validated values so later caller mutation
  // cannot alter the environment used to launch an MCP server.
  return Object.fromEntries(Object.entries(env)) as Record<string, string>;
}
