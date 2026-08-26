import { existsSync, readFileSync } from "node:fs";
import type { OAuthClientCredentials, OAuthTokenEndpointAuthMethod } from "@/oauth";
import { getKanaConfigPaths } from "../path";

const KANA_MCP_SERVER_TYPES = ["stdio", "http"] as const;

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

export type KanaMcpOAuth2Config = {
  type: "oauth2";
  clientId: string;
  clientSecretEnv?: string;
  redirectUri?: string;
  scopes?: string[];
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
  authorizationParameters: Record<string, string>;
  callbackTimeoutMs: number;
};

export type KanaMcpHttpServerConfig = KanaMcpCommonServerConfig & {
  type: "http";
  url: string;
  proxy?: string | false;
  headers: Record<string, string>;
  auth?: KanaMcpOAuth2Config;
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
  "proxy",
  "headers",
  "auth",
  "required",
  "startupTimeoutMs",
  "requestTimeoutMs",
  "includeTools",
  "excludeTools",
]);
const OAUTH2_KEYS = new Set([
  "type",
  "clientId",
  "clientSecretEnv",
  "redirectUri",
  "scopes",
  "tokenEndpointAuthMethod",
  "authorizationParameters",
  "callbackTimeoutMs",
]);
const OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS = new Set<OAuthTokenEndpointAuthMethod>([
  "none",
  "client_secret_basic",
  "client_secret_post",
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
  const url = readHttpUrl(server.url, `${name}.url`);
  const proxy = readOptionalHttpProxyUrl(server.proxy, `${name}.proxy`);
  const headers = readHttpHeaders(server.headers, `${name}.headers`);
  const auth = readOptionalOAuth2Config(server.auth, `${name}.auth`);
  if (auth !== undefined && new URL(url).protocol !== "https:") {
    throw new Error(`${name}.url must use https when OAuth is configured.`);
  }
  if (auth !== undefined && hasHeader(headers, "authorization")) {
    throw new Error(`${name}.headers cannot set Authorization when OAuth is configured.`);
  }

  return {
    type: "http",
    url,
    ...(proxy === undefined ? {} : { proxy }),
    headers,
    ...(auth === undefined ? {} : { auth }),
    ...parseCommonServerConfig(name, server),
  };
}

export function resolveKanaMcpOAuth2Client(
  config: KanaMcpOAuth2Config,
  env: NodeJS.ProcessEnv = process.env,
): OAuthClientCredentials {
  const clientSecret =
    config.clientSecretEnv === undefined ? undefined : env[config.clientSecretEnv];
  if (config.clientSecretEnv !== undefined && !clientSecret) {
    throw new Error(`MCP OAuth environment variable ${config.clientSecretEnv} is not set.`);
  }

  return {
    clientId: config.clientId,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(config.tokenEndpointAuthMethod === undefined
      ? {}
      : { tokenEndpointAuthMethod: config.tokenEndpointAuthMethod }),
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

function readOptionalHttpProxyUrl(value: unknown, name: string): string | false | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === false) {
    return false;
  }

  const raw = readRequiredNonBlankString(value, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP proxy URL.`);
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

function readOptionalOAuth2Config(value: unknown, name: string): KanaMcpOAuth2Config | undefined {
  if (value === undefined) {
    return undefined;
  }

  const auth = asRecord(value, name);
  assertKnownKeys(auth, OAUTH2_KEYS, name);
  if (auth.type !== "oauth2") {
    throw new Error(`${name}.type must be oauth2.`);
  }

  const clientSecretEnv = readOptionalEnvironmentName(
    auth.clientSecretEnv,
    `${name}.clientSecretEnv`,
  );
  const scopes = readOptionalNonEmptyStrings(auth.scopes, `${name}.scopes`);
  const tokenEndpointAuthMethod = readOptionalTokenEndpointAuthMethod(
    auth.tokenEndpointAuthMethod,
    `${name}.tokenEndpointAuthMethod`,
  );

  return {
    type: "oauth2",
    clientId: readRequiredNonBlankString(auth.clientId, `${name}.clientId`),
    ...(clientSecretEnv === undefined ? {} : { clientSecretEnv }),
    ...readOptionalOAuthRedirectUri(auth.redirectUri, `${name}.redirectUri`),
    ...(scopes === undefined ? {} : { scopes }),
    ...(tokenEndpointAuthMethod === undefined ? {} : { tokenEndpointAuthMethod }),
    authorizationParameters: readStringRecord(
      auth.authorizationParameters,
      `${name}.authorizationParameters`,
    ),
    callbackTimeoutMs: readPositiveInteger(
      auth.callbackTimeoutMs,
      5 * 60_000,
      `${name}.callbackTimeoutMs`,
    ),
  };
}

function readOptionalEnvironmentName(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const environmentName = readRequiredNonBlankString(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
    throw new Error(`${name} must be a valid environment variable name.`);
  }
  return environmentName;
}

function readOptionalTokenEndpointAuthMethod(
  value: unknown,
  name: string,
): OAuthTokenEndpointAuthMethod | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS.has(value as OAuthTokenEndpointAuthMethod)
  ) {
    throw new Error(
      `${name} must be one of: ${[...OAUTH2_TOKEN_ENDPOINT_AUTH_METHODS].join(", ")}.`,
    );
  }
  return value as OAuthTokenEndpointAuthMethod;
}

function readOptionalOAuthRedirectUri(value: unknown, name: string): { redirectUri?: string } {
  if (value === undefined) {
    return {};
  }
  const raw = readRequiredNonBlankString(value, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${name} must be an absolute loopback HTTP URL.`, { cause: error });
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname) || url.port === "") {
    throw new Error(`${name} must use HTTP, a loopback host, and an explicit port.`);
  }
  if (url.port === "0") {
    throw new Error(`${name} cannot use port zero; omit it to select a free port.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} cannot contain credentials, a query, or a fragment.`);
  }
  return { redirectUri: url.toString() };
}

function readOptionalNonEmptyStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = readStringArray(value, [], name);
  if (values.some((item) => !item.trim())) {
    throw new Error(`${name} values must be non-empty strings.`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} cannot contain duplicate values.`);
  }
  return values;
}

function readStringRecord(value: unknown, name: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value, name);
  for (const [key, item] of Object.entries(record)) {
    if (!key || typeof item !== "string" || !item) {
      throw new Error(`${name} keys and values must be non-empty strings.`);
    }
  }
  return { ...(record as Record<string, string>) };
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

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === name);
}
