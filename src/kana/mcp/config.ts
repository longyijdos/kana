import { existsSync, readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import type { OAuthClientCredentials, OAuthTokenEndpointAuthMethod } from "@/oauth";
import { nonEmptyString, parseWithSchema, positiveInteger, strictObject } from "@/utils";
import { getKanaConfigPaths } from "../path";

type KanaMcpCommonServerConfig = {
  readonly description?: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly includeTools?: readonly string[];
  readonly excludeTools?: readonly string[];
};

export type KanaMcpStdioServerConfig = KanaMcpCommonServerConfig & {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
};

export type KanaMcpOAuth2Config = {
  readonly type: "oauth2";
  readonly clientId?: string;
  readonly clientSecretEnv?: string;
  readonly redirectUri?: string;
  readonly scopes?: readonly string[];
  readonly tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
  readonly authorizationParameters: Record<string, string>;
  readonly callbackTimeoutMs: number;
};

export type KanaMcpHttpServerConfig = KanaMcpCommonServerConfig & {
  readonly type: "http";
  readonly url: string;
  readonly proxy?: string | false;
  readonly headers: Record<string, string>;
  readonly auth?: KanaMcpOAuth2Config;
};

// Stdio keeps `type` optional in JSON for compatibility with common MCP config
// files. HTTP is explicitly selected so a URL cannot be mistaken for a command.
export type KanaMcpServerConfig = KanaMcpStdioServerConfig | KanaMcpHttpServerConfig;

export type KanaMcpConfig = {
  readonly mcpServers: Record<string, KanaMcpServerConfig>;
};

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_RESERVED_HEADER_NAMES = new Set([
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
]);

const uniqueNames = () => Type.Array(nonEmptyString(), { uniqueItems: true });

const COMMON_SERVER_FIELDS = {
  description: Type.Optional(nonEmptyString()),
  startupTimeoutMs: Type.Optional(positiveInteger()),
  requestTimeoutMs: Type.Optional(positiveInteger()),
  includeTools: Type.Optional(uniqueNames()),
  excludeTools: Type.Optional(uniqueNames()),
};

const STDIO_SERVER_SCHEMA = strictObject({
  type: Type.Optional(Type.Literal("stdio")),
  command: nonEmptyString(),
  args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(nonEmptyString()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  ...COMMON_SERVER_FIELDS,
});

const OAUTH2_SCHEMA = strictObject({
  type: Type.Literal("oauth2"),
  clientId: Type.Optional(nonEmptyString()),
  clientSecretEnv: Type.Optional(
    Type.String({
      pattern: ENVIRONMENT_NAME.source,
      errorMessage: "must be a valid environment variable name",
    }),
  ),
  redirectUri: Type.Optional(nonEmptyString()),
  scopes: Type.Optional(uniqueNames()),
  tokenEndpointAuthMethod: Type.Optional(
    Type.Enum(["none", "client_secret_basic", "client_secret_post"]),
  ),
  authorizationParameters: Type.Optional(Type.Record(Type.String(), nonEmptyString())),
  callbackTimeoutMs: Type.Optional(positiveInteger()),
});

const HTTP_SERVER_SCHEMA = strictObject({
  type: Type.Literal("http"),
  url: nonEmptyString(),
  proxy: Type.Optional(
    Type.Union([Type.Literal(false), nonEmptyString()], {
      errorMessage: "must be false or a non-empty string",
    }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  auth: Type.Optional(OAUTH2_SCHEMA),
  ...COMMON_SERVER_FIELDS,
});

const MCP_CONFIG_SCHEMA = strictObject({
  mcpServers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const SERVER_TYPE_SCHEMA = Type.Object({
  type: Type.Optional(Type.Enum(["stdio", "http"])),
});

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
  const { mcpServers = {} } = parseWithSchema(MCP_CONFIG_SCHEMA, value, "MCP config");
  return {
    mcpServers: Object.fromEntries(
      Object.entries(mcpServers).map(([serverId, server]) => {
        if (!serverId.trim()) {
          throw new Error("mcpServers keys must be non-empty server IDs.");
        }
        return [serverId, parseServer(`mcpServers.${serverId}`, server)];
      }),
    ),
  };
}

function parseServer(name: string, value: unknown): KanaMcpServerConfig {
  const { type } = parseWithSchema(SERVER_TYPE_SCHEMA, value, name);
  return type === "http"
    ? parseHttpServer(name, parseWithSchema(HTTP_SERVER_SCHEMA, value, name))
    : parseStdioServer(name, parseWithSchema(STDIO_SERVER_SCHEMA, value, name));
}

function parseStdioServer(
  name: string,
  server: Static<typeof STDIO_SERVER_SCHEMA>,
): KanaMcpStdioServerConfig {
  const env = server.env ?? {};
  const invalidName = Object.keys(env).find((key) => !ENVIRONMENT_NAME.test(key));
  if (invalidName !== undefined) {
    throw new Error(`${name}.env contains invalid environment name ${invalidName}.`);
  }

  return {
    type: "stdio",
    command: server.command,
    args: server.args ?? [],
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    env,
    ...withServerDefaults(server),
  };
}

function parseHttpServer(
  name: string,
  server: Static<typeof HTTP_SERVER_SCHEMA>,
): KanaMcpHttpServerConfig {
  assertHttpUrl(server.url, `${name}.url`, "an absolute HTTP URL");
  if (typeof server.proxy === "string") {
    assertHttpUrl(server.proxy, `${name}.proxy`, "an absolute HTTP proxy URL");
  }
  const headers = server.headers ?? {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (HTTP_RESERVED_HEADER_NAMES.has(headerName.toLowerCase())) {
      throw new Error(`${name}.headers cannot override transport header ${headerName}.`);
    }
    try {
      new Headers([[headerName, headerValue]]);
    } catch (error) {
      throw new Error(`${name}.headers contains invalid HTTP header ${headerName}.`, {
        cause: error,
      });
    }
  }

  const auth = server.auth === undefined ? undefined : parseOAuth2(`${name}.auth`, server.auth);
  if (auth !== undefined && new URL(server.url).protocol !== "https:") {
    throw new Error(`${name}.url must use https when OAuth is configured.`);
  }
  if (
    auth !== undefined &&
    Object.keys(headers).some((key) => key.toLowerCase() === "authorization")
  ) {
    throw new Error(`${name}.headers cannot set Authorization when OAuth is configured.`);
  }

  return {
    type: "http",
    url: server.url,
    ...(server.proxy === undefined ? {} : { proxy: server.proxy }),
    headers,
    ...(auth === undefined ? {} : { auth }),
    ...withServerDefaults(server),
  };
}

function parseOAuth2(name: string, auth: Static<typeof OAUTH2_SCHEMA>): KanaMcpOAuth2Config {
  const { clientId, clientSecretEnv, scopes, tokenEndpointAuthMethod } = auth;
  if (
    clientId === undefined &&
    (clientSecretEnv !== undefined ||
      (tokenEndpointAuthMethod !== undefined && tokenEndpointAuthMethod !== "none"))
  ) {
    throw new Error(`${name}.clientId is required when client credentials are configured.`);
  }

  return {
    type: "oauth2",
    ...(clientId === undefined ? {} : { clientId }),
    ...(clientSecretEnv === undefined ? {} : { clientSecretEnv }),
    ...(auth.redirectUri === undefined
      ? {}
      : { redirectUri: parseRedirectUri(auth.redirectUri, `${name}.redirectUri`) }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(tokenEndpointAuthMethod === undefined ? {} : { tokenEndpointAuthMethod }),
    authorizationParameters: auth.authorizationParameters ?? {},
    callbackTimeoutMs: auth.callbackTimeoutMs ?? 5 * 60_000,
  };
}

export function resolveKanaMcpOAuth2Client(
  config: KanaMcpOAuth2Config,
  env: NodeJS.ProcessEnv = process.env,
): OAuthClientCredentials | undefined {
  if (config.clientId === undefined) {
    return undefined;
  }
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

function withServerDefaults(
  server: Static<typeof STDIO_SERVER_SCHEMA> | Static<typeof HTTP_SERVER_SCHEMA>,
): KanaMcpCommonServerConfig {
  return {
    ...(server.description === undefined ? {} : { description: server.description }),
    startupTimeoutMs: server.startupTimeoutMs ?? 10_000,
    requestTimeoutMs: server.requestTimeoutMs ?? 60_000,
    ...(server.includeTools === undefined ? {} : { includeTools: server.includeTools }),
    ...(server.excludeTools === undefined ? {} : { excludeTools: server.excludeTools }),
  };
}

function assertHttpUrl(raw: string, name: string, expected: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${name} must be ${expected}.`, { cause: error });
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
}

function parseRedirectUri(raw: string, name: string): string {
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
  return url.toString();
}
