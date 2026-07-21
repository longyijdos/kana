import { existsSync, readFileSync } from "node:fs";
import { getKanaConfigPaths } from "./config";

export const KANA_MCP_SERVER_TYPES = ["stdio", "http"] as const;

export type KanaMcpServerType = (typeof KANA_MCP_SERVER_TYPES)[number];

type KanaMcpCommonServerConfig = {
  required: boolean;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  includeTools?: string[];
  excludeTools?: string[];
};

export type KanaMcpStdioServerConfig = KanaMcpCommonServerConfig & {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
};

export type KanaMcpHttpServerConfig = KanaMcpCommonServerConfig & {
  type: "http";
  url: string;
  headers: Record<string, string>;
};

// Stdio keeps `type` optional in JSON for compatibility with common MCP config
// files. HTTP is explicitly selected so a URL cannot be mistaken for a command.
export type KanaMcpServerConfig = KanaMcpStdioServerConfig | KanaMcpHttpServerConfig;

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
const HTTP_SERVER_KEYS = new Set([
  "type",
  "url",
  "headers",
  "required",
  "startupTimeoutMs",
  "requestTimeoutMs",
  "includeTools",
  "excludeTools",
]);
const HTTP_RESERVED_HEADER_NAMES = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
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
        parseServer(serverId, rawServer),
      ]),
    ),
  };
}

function parseServer(serverId: string, value: unknown): KanaMcpServerConfig {
  const name = `mcpServers.${serverId}`;
  const server = asRecord(value, name);
  const type = readString(server.type, "stdio", `${name}.type`);
  if (!(KANA_MCP_SERVER_TYPES as readonly string[]).includes(type)) {
    throw new Error(`${name}.type must be one of: ${KANA_MCP_SERVER_TYPES.join(", ")}.`);
  }

  return type === "http" ? parseHttpServer(name, server) : parseStdioServer(name, server);
}

function parseStdioServer(name: string, server: Record<string, unknown>): KanaMcpStdioServerConfig {
  assertKnownKeys(server, STDIO_SERVER_KEYS, name);

  const cwd = readOptionalNonBlankString(server.cwd, `${name}.cwd`);

  return {
    type: "stdio",
    command: readRequiredNonBlankString(server.command, `${name}.command`),
    args: readStringArray(server.args, [], `${name}.args`),
    ...(cwd === undefined ? {} : { cwd }),
    env: readEnvironment(server.env, `${name}.env`),
    ...parseCommonServerConfig(name, server),
  };
}

function parseHttpServer(name: string, server: Record<string, unknown>): KanaMcpHttpServerConfig {
  assertKnownKeys(server, HTTP_SERVER_KEYS, name);

  return {
    type: "http",
    url: readHttpUrl(server.url, `${name}.url`),
    headers: readHttpHeaders(server.headers, `${name}.headers`),
    ...parseCommonServerConfig(name, server),
  };
}

function parseCommonServerConfig(
  name: string,
  server: Record<string, unknown>,
): KanaMcpCommonServerConfig {
  const includeTools = readOptionalToolNames(server.includeTools, `${name}.includeTools`);
  const excludeTools = readOptionalToolNames(server.excludeTools, `${name}.excludeTools`);

  return {
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

function readHttpUrl(value: unknown, name: string): string {
  const raw = readRequiredNonBlankString(value, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${name} must be an absolute HTTP URL.`, { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} cannot contain credentials.`);
  }
  if (url.hash) {
    throw new Error(`${name} cannot contain a fragment.`);
  }
  return raw;
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

function readHttpHeaders(value: unknown, name: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const headers = asRecord(value, name);
  const parsed: Array<[string, string]> = [];
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      throw new Error(`${name}.${headerName} must be a string.`);
    }
    if (HTTP_RESERVED_HEADER_NAMES.has(headerName.toLowerCase())) {
      throw new Error(`${name} cannot override transport header ${headerName}.`);
    }

    try {
      new Headers([[headerName, headerValue]]);
    } catch (error) {
      throw new Error(`${name} contains invalid HTTP header ${headerName}.`, { cause: error });
    }
    parsed.push([headerName, headerValue]);
  }

  // Header values may hold credentials. Snapshot them at the same trust
  // boundary as stdio env so caller mutation cannot change later connections.
  return Object.fromEntries(parsed);
}
