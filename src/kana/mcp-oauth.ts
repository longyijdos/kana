import { createNoopLogger, type Logger } from "@/logging";
import { McpOAuthHttpAuthorizer, type McpOAuthHttpDiagnosticEvent } from "@/mcp";
import type { OAuthFetch, OAuthStoredToken, OAuthTokenStore } from "@/oauth";
import { createHttpProxyFetch } from "./http-proxy";
import {
  type KanaMcpHttpServerConfig,
  type KanaMcpOAuth2Config,
  loadKanaMcpConfig,
  resolveKanaMcpOAuth2Client,
} from "./mcp-config";
import { openKanaOAuthAuthorizationUrl } from "./oauth-browser";
import { createKanaOAuthTokenStore, type KanaOAuthTokenStatus } from "./oauth-token-store";

type KanaMcpOAuthServerConfig = KanaMcpHttpServerConfig & {
  auth: KanaMcpOAuth2Config;
};

export type CreateKanaMcpOAuthAuthorizerOptions = {
  env: NodeJS.ProcessEnv;
  getLogger: () => Logger;
  tokenStore: OAuthTokenStore;
  openAuthorizationUrl(url: string): Promise<void>;
  fetch?: OAuthFetch;
  signal?: AbortSignal;
  onDiagnostic?(event: McpOAuthHttpDiagnosticEvent): void;
};

export type RunKanaMcpOAuthOptions = {
  env?: NodeJS.ProcessEnv;
  getLogger?: () => Logger;
  tokenStore?: OAuthTokenStore;
  openAuthorizationUrl?(url: string): Promise<void>;
  fetch?: OAuthFetch;
  signal?: AbortSignal;
  onDiagnostic?(event: McpOAuthHttpDiagnosticEvent): void;
};

export function createKanaMcpOAuthStorageKey(serverId: string): string {
  if (!serverId.trim()) {
    throw new Error("MCP server ID cannot be empty.");
  }
  return `mcp:${serverId}`;
}

export function createKanaMcpOAuthAuthorizer(
  serverId: string,
  config: KanaMcpOAuthServerConfig,
  options: CreateKanaMcpOAuthAuthorizerOptions,
): McpOAuthHttpAuthorizer {
  const fetch =
    config.proxy === undefined
      ? options.fetch
      : createHttpProxyFetch(config.proxy, options.fetch ?? globalThis.fetch);

  return new McpOAuthHttpAuthorizer({
    resource: config.url,
    storageKey: createKanaMcpOAuthStorageKey(serverId),
    client: resolveKanaMcpOAuth2Client(config.auth, options.env),
    tokenStore: options.tokenStore,
    openAuthorizationUrl: options.openAuthorizationUrl,
    ...(config.auth.redirectUri === undefined ? {} : { redirectUri: config.auth.redirectUri }),
    ...(config.auth.scopes === undefined ? {} : { scopes: config.auth.scopes }),
    additionalAuthorizationParameters: config.auth.authorizationParameters,
    callbackTimeoutMs: config.auth.callbackTimeoutMs,
    ...(fetch === undefined ? {} : { fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onDiagnostic: createDiagnosticHandler(serverId, options),
  });
}

export async function authorizeKanaMcpServer(
  serverId: string,
  options: RunKanaMcpOAuthOptions = {},
): Promise<KanaOAuthTokenStatus> {
  const context = createOperationContext(options);
  const server = requireOAuthServer(serverId, context.env);
  const authorizer = createKanaMcpOAuthAuthorizer(serverId, server, {
    ...context,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });

  try {
    await authorizer.authorize();
  } finally {
    authorizer.close();
  }

  const token = await context.tokenStore.load(createKanaMcpOAuthStorageKey(serverId));
  if (token === undefined) {
    throw new Error(`MCP server ${serverId} completed OAuth without storing credentials.`);
  }
  return storedTokenStatus(token);
}

export async function signOutKanaMcpServer(
  serverId: string,
  options: RunKanaMcpOAuthOptions = {},
): Promise<KanaOAuthTokenStatus> {
  const context = createOperationContext(options);
  requireOAuthServer(serverId, context.env);
  await context.tokenStore.delete(createKanaMcpOAuthStorageKey(serverId));
  try {
    context.getLogger().info("mcp.oauth_signed_out", { serverId });
  } catch {
    // Sign-out persistence succeeds independently of diagnostic logging.
  }
  return { state: "unauthorized", refreshable: false };
}

function createOperationContext(options: RunKanaMcpOAuthOptions): {
  env: NodeJS.ProcessEnv;
  getLogger: () => Logger;
  tokenStore: OAuthTokenStore;
  openAuthorizationUrl(url: string): Promise<void>;
} {
  const env = { ...(options.env ?? process.env) };
  const getLogger = options.getLogger ?? createNoopLogger;
  return {
    env,
    getLogger,
    tokenStore: options.tokenStore ?? createKanaOAuthTokenStore({ env, getLogger }),
    openAuthorizationUrl:
      options.openAuthorizationUrl ??
      ((url: string) => openKanaOAuthAuthorizationUrl(url, { getLogger })),
  };
}

function requireOAuthServer(serverId: string, env: NodeJS.ProcessEnv): KanaMcpOAuthServerConfig {
  const server = loadKanaMcpConfig(env).mcpServers[serverId];
  if (server === undefined) {
    throw new Error(`MCP server ${serverId} is not configured.`);
  }
  if (server.type !== "http" || server.auth === undefined) {
    throw new Error(`MCP server ${serverId} does not use OAuth.`);
  }
  return server as KanaMcpOAuthServerConfig;
}

function createDiagnosticHandler(
  serverId: string,
  options: Pick<CreateKanaMcpOAuthAuthorizerOptions, "getLogger" | "onDiagnostic">,
): (event: McpOAuthHttpDiagnosticEvent) => void {
  return (diagnostic) => {
    const { event, level, ...metadata } = diagnostic;
    try {
      options.getLogger()[level](event, { serverId, ...metadata });
    } catch {
      // Logging is diagnostic and cannot block authorization.
    }
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // Presentation callbacks cannot change authorization control flow.
    }
  };
}

function storedTokenStatus(token: OAuthStoredToken): KanaOAuthTokenStatus {
  return {
    state:
      token.expiresAt !== undefined && token.expiresAt <= Date.now() ? "expired" : "authorized",
    refreshable: token.refreshToken !== undefined,
    ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
  };
}
